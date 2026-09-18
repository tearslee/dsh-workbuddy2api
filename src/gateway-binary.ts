/**
 * 网关二进制的获取：平台映射 → 下载 → SHA256 校验 → 原子安装。
 *
 * ## 为什么需要这一步
 *
 * 上游 workbuddy2api **不提供预编译产物**，README 要求用户自己 `git clone` + 装 Go +
 * `go build`。对「只想装个插件的人」来说这是整条链路上最大的门槛（Windows 尤其如此）。
 * 本模块把这一步变成一次下载：产物由本仓库的 GitHub Actions 从上游源码交叉编译并
 * 连同 `SHA256SUMS.txt` 一起发布（见 `.github/workflows/release-binaries.yml`）。
 *
 * ## 三条硬约束
 *
 * 1. **校验失败即拒绝安装**。下载的是**要被执行的文件**，因此校验和文件拿不到时
 *    不是「警告后继续」而是直接失败，并告诉用户替代路径（自己编译 + `binaryPath`）。
 * 2. **原子落盘**。先写 `<name>.part` 再 `rename` —— 中途失败（断网/断电）留下的是
 *    一个显眼的 `.part`，而不是一个半截的、看起来可执行的二进制。
 * 3. **只装到插件自己的缓存目录**（默认 `~/.dsh/wb2api/bin/`，正是
 *    `GatewaySupervisor.resolveBinary()` 的第 3 个查找位置），绝不覆盖用户已有的
 *    `repoPath` 构建产物 —— 那可能是他自己编译的、带本地补丁的版本。
 *
 * @module dsh-workbuddy2api/gateway-binary
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractFile, ZipError } from './zip.js'

/** 下载源的默认仓库（本插件仓库的 Release，非上游）。 */
export const DEFAULT_RELEASE_REPO = 'tearslee/dsh-workbuddy2api'

/** 校验和文件名（由发布工作流生成）。 */
export const CHECKSUMS_NAME = 'SHA256SUMS.txt'

/** 二进制名（Windows 带 `.exe`，与上游构建命令 `go build -o wb2a-server.exe` 一致）。 */
export const BINARY_BASENAME = 'wb2a-server'

/** 网关运行时配置文件名（网关硬编码的默认值就是 `config.json`）。 */
export const CONFIG_NAME = 'config.json'

/** 目标平台（Go 的 GOOS/GOARCH 命名，与发布产物一致）。 */
export interface Target {
  /** `windows` / `darwin` / `linux`。 */
  os: string
  /** `amd64` / `arm64`。 */
  arch: string
}

/** 发布产物名，例如 `wb2a-server-windows-amd64.zip`。 */
export function assetName(target: Target): string {
  return `${BINARY_BASENAME}-${target.os}-${target.arch}.zip`
}

/** 该平台上的可执行文件名（Windows 需要 `.exe` 后缀才对 `spawn` 有效）。 */
export function binaryFileName(target: Target): string {
  return target.os === 'windows' ? `${BINARY_BASENAME}.exe` : BINARY_BASENAME
}

/**
 * 把 Node 的 `process.platform` / `process.arch` 映射成 Go 的 GOOS/GOARCH。
 *
 * 只支持**有发布产物**的组合；其余（如 `win32/ia32`）返回 undefined，由调用方
 * 给出「自行编译」的指引 —— 静默回退到某个相近架构会产出一个跑不起来的文件。
 */
export function currentTarget(platform: string, arch: string): Target | undefined {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  const goArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined
  if (os === undefined || goArch === undefined) return undefined
  return { os, arch: goArch }
}

/** 默认安装目录：`~/.dsh/wb2api/bin`（同时也是 supervisor 的自动探测路径之一）。 */
export function defaultInstallDir(): string {
  return join(homedir(), '.dsh', 'wb2api', 'bin')
}

/**
 * 网关运行时根目录（`config.json` / `auths/` 所在处）。
 *
 * 取安装目录的**上一级**：`~/.dsh/wb2api/`，子目录 `bin/` 只放可执行文件。
 * 这样「可执行文件」与「运行数据」分开，重装二进制不会碰到账号凭证。
 */
export function defaultRuntimeDir(): string {
  return join(homedir(), '.dsh', 'wb2api')
}

/**
 * 生成最小可用配置。
 *
 * ## 为什么必须有这个文件（实测，不是推测）
 *
 * 上游 `cmd/server/main.go` 确实写了「配置不存在则用默认值 + 环境变量」的兜底：
 *
 * ```go
 * if os.IsNotExist(err) { cfg, err = Load("") }
 * ```
 *
 * 但 `Load()` 把错误包装过：`fmt.Errorf("read config: %w", err)`，于是
 * `os.IsNotExist(err)` 对包装后的错误**返回 false** —— 兜底分支永远进不去，
 * 进程直接 `log.Fatalf("load config: ...")` 退出（实测：把二进制放进空目录执行，
 * 4 秒内即退出，stdout 只有一行 `load config: read config: open config.json:
 * The system cannot find the file specified.`）。
 *
 * 所以对「只有二进制、没有网关源码」的插件用户，这个文件是**必须由插件生成**的，
 * 否则新装用户 100% 起不来。
 *
 * ## 两项刻意的选择
 *
 * 1. **`listen` 绑 127.0.0.1**，不是上游示例的 `:7863`。`:7863` 会监听 `0.0.0.0`
 *    （实测 `netstat` 显示 `0.0.0.0:7863` LISTENING），等于把带账号池的网关暴露到
 *    局域网。插件与网关同机，没有任何理由对外监听。
 * 2. **生成随机 `api_key`**。网关的鉴权在 `api_key` 为空时是**完全关闭**的
 *    （`withAuth` 直接放行），而 `/status` 会暴露账号清单与积分。因此哪怕只监听
 *    本机，也不该留空 —— 同机上的任何进程都能读。
 *
 * `auth_dir` / `state_file` 保持上游默认的相对路径，由调用方负责先建好目录。
 *
 * @param listenPort - 监听端口。
 * @returns 配置对象（调用方负责写盘）。
 */
export function buildMinimalConfig(listenPort: number): Record<string, unknown> {
  return {
    listen: `127.0.0.1:${listenPort}`,
    api_key: randomBytes(24).toString('hex'),
    auth_dir: './auths',
    state_file: './data/state.json',
  }
}

/**
 * 确保运行目录里存在可用的 `config.json` 与所需子目录。
 *
 * **已存在的配置文件绝不覆盖**（可能含用户自己的账号池调参、冷却策略、
 * 或指向别处的 `auth_dir`）。只在缺失时补建，并把生成的 api_key 回报给调用方
 * 供读取凭据时使用。
 *
 * `auths/` 目录**必须预先存在**：实测网关只在启动时探测该目录，不存在就
 * 「跳过热加载监听」且*永不重试*（启动日志：`[watch] auths 目录 ./auths 不可读，
 * 跳过热加载监听（加账号后需手动重启）`）。先建好目录，登录写入的账号才能被
 * 5 秒轮询自动加载。
 *
 * @param runtimeDir - 运行时根目录。
 * @param listenPort - 监听端口（仅用于新建配置时）。
 * @returns 运行目录、配置文件路径，以及本次是否新建了配置。
 */
export function ensureRuntimeDir(
  runtimeDir: string,
  listenPort: number,
): { dir: string; configPath: string; created: boolean; dirsCreated: string[] } {
  const dirsCreated: string[] = []
  const configPath = join(runtimeDir, CONFIG_NAME)
  for (const sub of ['auths', 'data']) {
    const path = join(runtimeDir, sub)
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true })
      dirsCreated.push(path)
    }
  }
  if (existsSync(configPath)) {
    return { dir: runtimeDir, configPath, created: false, dirsCreated }
  }
  mkdirSync(runtimeDir, { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(buildMinimalConfig(listenPort), null, 2)}\n`, { mode: 0o600 })
  return { dir: runtimeDir, configPath, created: true, dirsCreated }
}

/** 读取运行目录里配置的 api_key（读不到返回 undefined）。 */
export function readConfigApiKey(runtimeDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeDir, CONFIG_NAME), 'utf8')) as { api_key?: unknown }
    return typeof parsed.api_key === 'string' && parsed.api_key.length > 0 ? parsed.api_key : undefined
  } catch {
    return undefined
  }
}

/**
 * 构造某个产物的下载地址。
 *
 * 默认走 `releases/latest/download/<asset>` —— 这个 GitHub 约定地址永远指向最新 release，
 * 插件因此**不需要把自己的版本号烧进 URL**（避免「插件升级了但二进制还指向旧 tag」）。
 * 需要钉住某个版本时由 `binaryReleaseBase` 显式覆盖。
 */
export function assetUrl(repo: string, target: Target, base?: string): string {
  const root = base !== undefined && base !== '' ? base.replace(/\/+$/, '') : `https://github.com/${repo}/releases/latest/download`
  return `${root}/${assetName(target)}`
}

/** 校验和清单的下载地址（与产物同源）。 */
export function checksumsUrl(repo: string, base?: string): string {
  const root = base !== undefined && base !== '' ? base.replace(/\/+$/, '') : `https://github.com/${repo}/releases/latest/download`
  return `${root}/${CHECKSUMS_NAME}`
}

/**
 * 解析 `SHA256SUMS.txt`（`sha256sum` 格式：`<64位十六进制><空白><文件名>`）。
 *
 * 兼容 `sha256sum` 的两空格写法与文件名前导 `*`（二进制模式标记）。
 *
 * **文件名会做路径归一**：CI 里执行的是 `sha256sum ./*.zip`，产出的名字带 `./`
 * 前缀（实测：`./wb2a-server-windows-amd64.zip`）。若按原名建表，查找
 * `wb2a-server-windows-amd64.zip` 会落空，表现为「清单里没有本平台条目」而**拒绝
 * 安装**——即所有用户都装不上。归一规则：去掉前导 `./`，并额外登记 basename
 * （`sub/dir/x.zip` 也能用 `x.zip` 命中，但**仅在不与该 basename 的已知条目冲突时**，
 * 避免歧义时随机取一个）。
 *
 * @returns 文件名（已归一）→ 小写十六进制摘要。
 */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const basenames = new Map<string, string | undefined>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match === null) continue
    const digest = match[1]!.toLowerCase()
    // 归档在目录里时 sha256sum 会带路径；统一剥掉前导 ./ 与任意多余分隔符。
    const name = match[2]!.replace(/^\.\//, '')
    out.set(name, digest)
    const base = name.split('/').pop() ?? name
    // 同名 basename 出现两次（不同目录）时置为 undefined 表示"有歧义"，只留全名。
    basenames.set(base, basenames.has(base) ? undefined : digest)
  }
  for (const [base, digest] of basenames) {
    if (digest !== undefined && !out.has(base)) out.set(base, digest)
  }
  return out
}

/** 计算字节的 SHA256（小写十六进制）。 */
export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 下载与安装的结果。 */
export interface InstallResult {
  /** 最终可执行文件路径。 */
  path: string
  /** 是否真的下载了（false = 已存在且未要求强制）。 */
  downloaded: boolean
  /** 产物名。 */
  asset: string
  /** 校验通过的摘要。 */
  sha256?: string
  /** 字节数。 */
  bytes?: number
  /** 网关运行目录（本次已确保存在 `config.json` 与 `auths/`、`data/`）。 */
  runtimeDir: string
  /** 配置文件路径。 */
  configPath: string
  /** 本次是否新建了配置文件。 */
  configCreated: boolean
  /** 本次新建的目录（用于如实汇报动过什么）。 */
  dirsCreated: string[]
}

/** 日志接口（与其它模块保持一致的最小交集）。 */
export interface BinaryLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface EnsureBinaryOptions {
  /** 安装目录（默认 {@link defaultInstallDir}）。 */
  installDir?: string
  /**
   * 网关运行目录（默认 {@link defaultRuntimeDir}）。
   *
   * 可执行文件与 `config.json` 可以分处两地（`bin/` 与根目录就是这样分工的）。
   */
  runtimeDir?: string
  /** 监听端口；仅用于新建 `config.json`。 */
  listenPort?: number
  /** 发布仓库 `owner/name`。 */
  repo?: string
  /** 覆盖下载根地址（自建镜像 / 钉版本）。 */
  releaseBase?: string
  /** 目标平台；默认取当前进程。 */
  target?: Target
  /** 已存在时是否重新下载。 */
  force?: boolean
  logger?: BinaryLogger
  /** 注入 fetch，便于测试。 */
  fetchImpl?: typeof fetch
  /** 下载超时（毫秒）。 */
  timeoutMs?: number
}

/** 下载二进制并安装；返回可执行文件绝对路径。 */
export class GatewayBinaryInstaller {
  private readonly fetchImpl: typeof fetch
  private readonly logger: BinaryLogger
  private readonly timeoutMs: number

  constructor(private readonly options: EnsureBinaryOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.logger = options.logger ?? { info: () => {}, warn: () => {}, error: () => {} }
    this.timeoutMs = options.timeoutMs ?? 120_000
  }

  /** 安装目录。 */
  installDir(): string {
    return this.options.installDir ?? defaultInstallDir()
  }

  /** 网关运行目录。 */
  runtimeDir(): string {
    return this.options.runtimeDir ?? defaultRuntimeDir()
  }

  /**
   * 只准备运行目录（`config.json` + `auths/` + `data/`），不碰二进制。
   *
   * 给「二进制已经在位」的路径用：那种情况下不会走 {@link ensure}，但运行目录
   * 仍可能缺失（例如二进制是**更早版本的插件**下载的，那时还不生成 config.json），
   * 少了这一步，`/wb2api-setup` 会报「网关启动失败」而看不出是缺配置文件。
   */
  prepareRuntime(): ReturnType<typeof ensureRuntimeDir> {
    const runtime = ensureRuntimeDir(this.runtimeDir(), this.options.listenPort ?? 7863)
    if (runtime.created) {
      this.logger.info(`[workbuddy2api] 已生成网关运行配置：${runtime.configPath}（随机 api_key，仅监听 127.0.0.1）`)
    }
    return runtime
  }

  /** 目标平台；不受支持时抛错（调用方应据此给出「自行编译」指引）。 */
  target(): Target {
    const explicit = this.options.target
    if (explicit !== undefined) return explicit
    const detected = currentTarget(process.platform, process.arch)
    if (detected === undefined) {
      throw new Error(
        `workbuddy2api: 没有适配 ${process.platform}/${process.arch} 的预编译产物。`
        + '请自行编译：git clone https://github.com/Sliverkiss/workbuddy2api'
        + ' && go build -o wb2a-server ./cmd/server，然后把插件配置 binaryPath 指向它。',
      )
    }
    return detected
  }

  /** 目标安装路径。 */
  binaryPath(): string {
    return join(this.installDir(), binaryFileName(this.target()))
  }

  /** 一次带超时的 GET；非 2xx 抛错并带上状态码。 */
  private async get(url: string): Promise<Uint8Array> {
    const response = await this.fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'application/octet-stream, text/plain, */*' },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`GET ${url} 返回 HTTP ${response.status}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * 确保二进制可用。
   *
   * 无论二进制是不是本次下载的，都会确保运行目录就绪（`config.json` + `auths/` +
   * `data/`）—— 因为「二进制有了但目录没准备好」同样起不来（见
   * {@link ensureRuntimeDir} 里记录的实测结论）。
   *
   * @returns 安装结果（含运行目录信息）。
   * @throws 平台不支持、下载失败、归档里没有该文件、校验和不匹配时。
   */
  async ensure(): Promise<InstallResult> {
    const target = this.target()
    const asset = assetName(target)
    const finalPath = this.binaryPath()
    const runtime = this.prepareRuntime()

    if (!this.options.force && existsSync(finalPath)) {
      this.logger.info(`[workbuddy2api] 网关二进制已存在，跳过下载：${finalPath}`)
      return {
        path: finalPath,
        downloaded: false,
        asset,
        runtimeDir: runtime.dir,
        configPath: runtime.configPath,
        configCreated: runtime.created,
        dirsCreated: runtime.dirsCreated,
      }
    }

    const repo = this.options.repo ?? DEFAULT_RELEASE_REPO
    const url = assetUrl(repo, target, this.options.releaseBase)

    // 1) 先取校验和。拿不到就**不下载**：宁可失败，也不要装一个无法验证的可执行文件。
    let expected: string | undefined
    try {
      const checksumBytes = await this.get(checksumsUrl(repo, this.options.releaseBase))
      const table = parseChecksums(new TextDecoder().decode(checksumBytes))
      expected = table.get(asset)
      if (expected === undefined) {
        throw new Error(`${CHECKSUMS_NAME} 里没有 ${asset} 的记录`)
      }
    } catch (error) {
      throw new Error(
        `workbuddy2api: 无法获取校验和清单（${error instanceof Error ? error.message : String(error)}）。`
        + '出于安全考虑，未校验的二进制不会被安装。\n'
        + '替代方案：自行编译网关（git clone https://github.com/Sliverkiss/workbuddy2api'
        + ' && go build -o wb2a-server ./cmd/server），并在插件配置里指定 binaryPath。',
      )
    }

    // 2) 下载归档 → 校验 → 解压。
    this.logger.info(`[workbuddy2api] 下载网关二进制：${url}`)
    const archive = await this.get(url)
    const actual = sha256(archive)
    if (actual !== expected) {
      throw new Error(`workbuddy2api: ${asset} 校验和不匹配（期望 ${expected}，实际 ${actual}）。已放弃安装。`)
    }

    let payload: Uint8Array
    try {
      payload = extractFile(archive, binaryFileName(target))
    } catch (error) {
      if (error instanceof ZipError) throw new Error(`workbuddy2api: ${asset} 内容异常：${error.message}`)
      throw error
    }

    // 3) 原子落盘到插件自己的缓存目录。
    const dir = this.installDir()
    mkdirSync(dir, { recursive: true })
    const partPath = `${finalPath}.part`
    try {
      writeFileSync(partPath, payload)
      if (target.os !== 'windows') chmodSync(partPath, 0o755)
      renameSync(partPath, finalPath)
    } catch (error) {
      rmSync(partPath, { force: true })
      throw new Error(
        `workbuddy2api: 写入 ${finalPath} 失败（${error instanceof Error ? error.message : String(error)}）。`
        + '若该文件正被运行中的网关占用，请先执行 /wb2api-restart 停掉它，或改用 /wb2api-status 查看状态。',
      )
    }

    this.logger.info(`[workbuddy2api] 网关二进制已安装：${finalPath}（${payload.byteLength} 字节，sha256 ${actual.slice(0, 12)}…）`)
    return {
      path: finalPath,
      downloaded: true,
      asset,
      sha256: actual,
      bytes: payload.byteLength,
      runtimeDir: runtime.dir,
      configPath: runtime.configPath,
      configCreated: runtime.created,
      dirsCreated: runtime.dirsCreated,
    }
  }
}
