/**
 * 网关子进程托管：定位可执行文件 → 探活 → 拉起 → 崩溃重启 → dispose 回收。
 *
 * 这是插件相对「手工常驻 wb2api 进程」的核心收益：dsh 启动时网关随之启动，
 * dsh 退出时网关随之释放（`dsh-subprocess` 的 dispose 会终止全部受管进程）。
 *
 * 两个必须尊重的既有事实：
 *  1. **子进程环境被清洗** —— `dsh-subprocess` 会移除凭据形名称与全部 `DSH_*`
 *     （`scrubbedParentEnv`）。网关需要的变量必须经 `spawn` 的显式 `env` 传入。
 *  2. **启动 ≠ 可用** —— 网关需要 `auths/*.json` 账号凭证；没有账号时 `/healthz`
 *     即使有响应也可能是 `healthy: 0`。因此探活必须解析 `healthy` / `total`，
 *     而不能只看 HTTP 200。
 *
 * @module dsh-workbuddy2api/gateway-supervisor
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { gatewayOrigin, gatewayPort, type GatewayPluginConfig } from './config.js'
import { defaultRuntimeDir } from './gateway-binary.js'

/** 探活结果。 */
export interface HealthReport {
  /** 可用账号数（`/healthz` 的 `healthy`）。 */
  healthy: number
  /** 账号总数（`/healthz` 的 `total`）。 */
  total: number
  /** 服务标识，网关固定为 `workbuddy2api`。 */
  service?: string
  /** 各 realm 是否可服务（`cn` / `global`）。 */
  realmServable?: Record<string, boolean>
  /** 原始响应体，便于状态命令透出更多字段。 */
  raw: Record<string, unknown>
}

/** 网关生命周期状态。 */
export type GatewayState = 'stopped' | 'external' | 'starting' | 'running' | 'unhealthy' | 'failed'

/** 状态命令使用的完整快照。 */
export interface GatewayStatus {
  /** 生命周期状态。`external` 表示端口上已有一个非本插件拉起的健康网关，已直接复用。 */
  state: GatewayState
  /** 端点根。 */
  baseURL: string
  /** 监听端口。 */
  port: number
  /** 实际使用的可执行文件路径（`external` 或未启动时可能缺席）。 */
  binaryPath?: string
  /** 本插件托管的子进程 pid（`external` 时缺席）。 */
  pid?: number
  /** 探活结果；未探到则为 undefined。 */
  health?: HealthReport
  /** 累计自动重启次数。 */
  restarts: number
  /** 最近一次失败原因。 */
  lastError?: string
  /** 子进程 stderr 的尾部（诊断用）。 */
  recentStderr?: string
}

/** 子进程可执行文件的候选名（按优先级）。 */
const BINARY_CANDIDATES = [
  'wb2a-server.exe',
  'wb2api-server.exe',
  'wb2api.exe',
  'wb2a.exe',
  'wb2api-server',
  'wb2a-server',
  'wb2api',
  'wb2a',
]

/** 日志接口（与 cordis logger 的最小交集）。 */
export interface SupervisorLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 托管器依赖。 */
export interface GatewaySupervisorOptions {
  config: GatewayPluginConfig
  subprocess: SubprocessRuntime
  logger: SupervisorLogger
  /** 注入 fetch，便于测试。 */
  fetchImpl?: typeof fetch
}

/**
 * 判断错误是否表示「连接被拒」——即端口上没有服务在监听。
 *
 * 探活时这是**正常**结果（网关未启动），不是故障。
 */
function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { cause?: { code?: unknown } }).cause?.code
  if (code === 'ECONNREFUSED') return true
  // undici 把连接失败包成 TypeError('fetch failed')，cause 里才带 code。
  return error.name === 'TypeError' && code === undefined
}

/**
 * 网关进程托管器。
 *
 * 生命周期与插件 fiber 绑定：`dispose()` 会终止本插件拉起的全部子进程。
 */
export class GatewaySupervisor {
  private readonly fetchImpl: typeof fetch
  private handle: SubprocessHandle | undefined
  private state: GatewayState = 'stopped'
  private restarts = 0
  private lastError: string | undefined
  private resolvedBinary: string | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  /** 显式停止标志：抑制「进程退出 → 自动重启」的联动。 */
  private stopping = false
  private disposed = false

  constructor(private readonly options: GatewaySupervisorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** 端点根（去掉 `/v1`），用于打 `/healthz`。 */
  private get origin(): string {
    return gatewayOrigin(this.options.config.baseURL)
  }

  /** 监听端口。 */
  private get port(): number {
    return gatewayPort(this.options.config.baseURL, this.options.config.listenPort)
  }

  /**
   * 解析网关可执行文件路径。
   *
   * 查找顺序（先显式配置，后推断，避免"配了却找不到"被静默忽略）：
   *  1. `binaryPath` 配置项 —— 显式指定，不存在则**直接报错**而不是继续找；
   *  2. `repoPath` 根目录及其 `bin/` 子目录下的候选名；
   *  3. `~/.dsh/wb2api/bin/` 缓存目录（预留给按需 `go build` 的产物）；
   *  4. 交给 `ctx.subprocess.resolveExecutable()` 走 PATH。
   *
   * @returns 可执行文件绝对路径。
   * @throws 全部候选都找不到时抛错，错误消息列出所有已尝试位置。
   */
  async resolveBinary(): Promise<string> {
    if (this.resolvedBinary !== undefined) return this.resolvedBinary

    const tried: string[] = []
    const { binaryPath, repoPath } = this.options.config

    if (binaryPath.length > 0) {
      if (existsSync(binaryPath)) {
        this.resolvedBinary = binaryPath
        return binaryPath
      }
      throw new Error(
        `workbuddy2api: 配置的 binaryPath 不存在：${binaryPath}。`
        + '请修正插件配置，或清空该项让插件自动探测。',
      )
    }

    const dirs: string[] = []
    if (repoPath.length > 0) {
      dirs.push(repoPath, join(repoPath, 'bin'))
    }
    dirs.push(join(homedir(), '.dsh', 'wb2api', 'bin'))

    for (const dir of dirs) {
      for (const candidate of BINARY_CANDIDATES) {
        const full = join(dir, candidate)
        tried.push(full)
        if (existsSync(full)) {
          this.resolvedBinary = full
          return full
        }
      }
    }

    // 最后尝试 PATH（可能已全局安装）。
    for (const candidate of BINARY_CANDIDATES) {
      try {
        const resolved = await this.options.subprocess.resolveExecutable(candidate)
        this.resolvedBinary = resolved
        return resolved
      } catch {
        tried.push(`PATH:${candidate}`)
      }
    }

    throw new Error(
      'workbuddy2api: 未找到网关可执行文件。已尝试：\n  '
      + tried.join('\n  ')
      + '\n请设置插件配置 binaryPath，或把 repoPath 指向 workbuddy2api 源码目录。',
    )
  }

  /**
   * 决定子进程的工作目录。
   *
   * 顺序（先显式配置，再推断）：
   *  1. `workingDir` —— 用户显式指定；
   *  2. `repoPath` —— 用户有网关源码，其 `config.json` / `auths/` 就在这里；
   *  3. **`~/.dsh/wb2api/`（插件的运行目录）** —— 二进制由 `/wb2api-setup` 下载时，
   *     配置与凭证都放在那里（见 gateway-binary.ts 的 `ensureRuntimeDir`）；
   *  4. 可执行文件所在目录 —— 最后的兜底。
   *
   * 第 3 条不能省：网关的 `config.json` / `auth_dir` / `state_file` 全是**相对 cwd**
   * 的路径，cwd 指错地方就会去读一个不存在的配置（表现为启动即退出）。
   */
  private resolveWorkingDir(argv0: string): string {
    const { workingDir, repoPath } = this.options.config
    if (workingDir.length > 0) return workingDir
    if (repoPath.length > 0) return repoPath
    // 运行目录存在（含 config.json）时优先用它，否则退回可执行文件所在目录。
    const runtime = join(homedir(), '.dsh', 'wb2api')
    if (existsSync(join(runtime, 'config.json'))) return runtime
    return join(argv0, '..')
  }

  /**
   * 探活 `GET /healthz`（**该端点无需鉴权**）。
   *
   * @returns 探活结果；端口无监听时返回 undefined。
   * @throws 端口有监听但 `/healthz` 返回非 2xx（说明占用的不是本网关）时抛错。
   */
  async probe(): Promise<HealthReport | undefined> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.origin}/healthz`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.options.config.healthTimeoutSeconds * 1000),
      })
    } catch (error) {
      if (isConnectionRefused(error)) return undefined
      // 超时同样视作"不可用"，但保留原因供状态命令展示。
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return undefined
      return undefined
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(
        `workbuddy2api: ${this.origin} 上有服务在监听，但 /healthz 返回 HTTP ${response.status}`
        + `${body.length > 0 ? `：${body.slice(0, 200)}` : ''}。端口可能被其他程序占用。`,
      )
    }

    let raw: Record<string, unknown>
    try {
      raw = await response.json() as Record<string, unknown>
    } catch {
      throw new Error(`workbuddy2api: ${this.origin}/healthz 返回的不是 JSON，端口可能被其他程序占用。`)
    }

    const healthy = typeof raw.healthy === 'number' ? raw.healthy : 0
    const total = typeof raw.total === 'number' ? raw.total : 0
    return {
      healthy,
      total,
      ...typeof raw.service === 'string' ? { service: raw.service } : {},
      ...typeof raw.realm_servable === 'object' && raw.realm_servable !== null
        ? { realmServable: raw.realm_servable as Record<string, boolean> }
        : {},
      raw,
    }
  }

  /**
   * 统计网关实际读取的 `auths/` 目录下的凭证文件数（诊断「网关起来了但没有账号」）。
   *
   * 目录按网关**真实的工作目录**推导（`workingDir` → `repoPath` → 插件运行目录），
   * 与 `resolveWorkingDir()` 同源：写死 `repoPath/auths` 会让「自动下载二进制」的用户
   * 永远看到 0（凭证在运行目录里，而他没配 repoPath）。
   */
  countAuthFiles(): number {
    const cwd = this.options.config.workingDir.length > 0
      ? this.options.config.workingDir
      : this.options.config.repoPath.length > 0 ? this.options.config.repoPath : defaultRuntimeDir()
    try {
      const dir = join(cwd, 'auths')
      if (!existsSync(dir)) return 0
      return readdirSync(dir).filter(name => name.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  /**
   * 启动网关。
   *
   * 行为分三种：
   *  - 端口上已有**健康**网关 → 直接复用（`external`），不重复拉起。
   *    这正是「用户已手工常驻网关」场景下的正确行为，也避免了端口冲突。
   *  - 端口被非网关程序占用 → 抛错。
   *  - 端口空闲 → 解析二进制并 spawn，随后轮询 `/healthz` 直到就绪或超时。
   *
   * @returns 启动后的状态快照。
   */
  async start(): Promise<GatewayStatus> {
    if (this.handle !== undefined || this.state === 'external') return this.status()
    this.stopping = false
    this.state = 'starting'
    this.lastError = undefined

    // 1. 先探：已有健康网关就直接复用。
    try {
      const existing = await this.probe()
      if (existing !== undefined) {
        this.state = 'external'
        this.options.logger.info(
          `[workbuddy2api] 复用已在 ${this.origin} 运行的网关（healthy=${existing.healthy}/${existing.total}）`,
        )
        return this.status()
      }
    } catch (error) {
      this.state = 'failed'
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }

    // 2. 拉起受管进程。
    const argv0 = await this.resolveBinary()
    const cwd = this.resolveWorkingDir(argv0)

    this.options.logger.info(`[workbuddy2api] 启动网关：${argv0}（cwd=${cwd}）`)
    const handle = this.options.subprocess.spawn({
      argv: [argv0],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
        stderr: { maxBytes: 64 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
      },
      graceMs: this.options.config.graceMs,
      // 子进程环境被 dsh 清洗过（凭据形名称 + DSH_* 全移除），
      // 网关需要的变量必须在这里显式传入。
      env: { ...this.options.config.env },
    })
    this.handle = handle
    void this.watchExit(handle)

    // 3. 轮询探活，等网关真正可用。
    const health = await this.waitForHealth(handle)
    if (health === undefined) {
      this.state = 'failed'
      // 子进程若已退出，watchExit 已经写下更准确的病因（退出码/信号），不要覆盖它。
      this.lastError ??= `网关已拉起，但 ${this.healthDeadlineMs()}ms 内 /healthz 未就绪`
      this.options.logger.error(`[workbuddy2api] ${this.lastError}`)
      return this.status()
    }

    this.state = health.healthy > 0 ? 'running' : 'unhealthy'
    if (health.healthy === 0) {
      // 进程活着但没账号：明确告知，而不是假装成功。
      const authFiles = this.countAuthFiles()
      this.options.logger.warn(
        `[workbuddy2api] 网关已启动，但可用账号为 0（auths/ 下 ${authFiles} 个凭证文件）。`
        + '请先完成登录（/wb2api-login）。',
      )
    }
    return this.status()
  }

  /**
   * 启动后等待 `/healthz` 就绪的总预算（毫秒）。
   *
   * 取 `healthTimeoutSeconds` 的 10 倍：单次探活超时是「网络往返」级别的耐心，
   * 而进程启动还要加载账号池与状态文件，需要更长的总预算。
   */
  private healthDeadlineMs(): number {
    return this.options.config.healthTimeoutSeconds * 1000 * 10
  }

  /** 轮询探活直到就绪、进程退出或超时。 */
  private async waitForHealth(handle: SubprocessHandle): Promise<HealthReport | undefined> {
    const deadline = Date.now() + this.healthDeadlineMs()
    // 进程退出也必须立刻结束等待：否则一个「起了就退」的二进制会让我们白等满整个预算。
    // 这里显式 race 而不是靠 this.handle 被 watchExit 清空 —— 后者与 watchExit 的
    // 异步推进存在竞态，可能导致 lastError 尚未写入就被读取。
    const exited = handle.done.then(() => 'exited' as const, () => 'exited' as const)
    while (Date.now() < deadline) {
      const outcome = await Promise.race([
        this.probe().then(health => health ?? 'unhealthy' as const, () => 'unhealthy' as const),
        exited,
        new Promise<'tick'>(resolve => { setTimeout(() => resolve('tick'), 250) }),
      ])
      if (outcome === 'exited') {
        // 让 watchExit 完成它那半边状态更新，保证 lastError 已就绪。
        await Promise.resolve()
        return undefined
      }
      if (outcome !== 'unhealthy' && outcome !== 'tick') return outcome
    }
    return undefined
  }

  /** 监视子进程退出，按策略自动重启。 */
  private async watchExit(handle: SubprocessHandle): Promise<void> {
    let outcome: { exitCode: number | null; signal: string | null }
    try {
      outcome = await handle.done
    } catch (error) {
      outcome = { exitCode: null, signal: null }
      this.lastError = `网关进程启动失败：${error instanceof Error ? error.message : String(error)}`
    }
    if (this.handle !== handle) return // 已被主动替换/停止
    this.handle = undefined

    if (this.stopping || this.disposed) {
      this.state = 'stopped'
      return
    }

    this.lastError = `网关进程意外退出（exitCode=${String(outcome.exitCode)} signal=${String(outcome.signal)}）`
    this.options.logger.warn(`[workbuddy2api] ${this.lastError}`)

    if (this.restarts >= this.options.config.crashRestartLimit) {
      this.state = 'failed'
      this.lastError += `；已达自动重启上限 ${this.options.config.crashRestartLimit} 次，停止重启。`
      this.options.logger.error(`[workbuddy2api] ${this.lastError}`)
      return
    }

    this.restarts += 1
    // 退避重启：避免二进制损坏时疯狂拉起。
    const delayMs = Math.min(1000 * 2 ** (this.restarts - 1), 30_000)
    this.options.logger.info(`[workbuddy2api] ${delayMs}ms 后自动重启（第 ${this.restarts} 次）`)
    this.state = 'starting'
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.disposed || this.stopping) return
      void this.start().catch((error: unknown) => {
        this.options.logger.error(`[workbuddy2api] 自动重启失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, delayMs)
    this.restartTimer.unref?.()
  }

  /**
   * 停止本插件拉起的网关进程。
   *
   * `external` 状态（复用他人启动的网关）下**不会**去杀别人的进程 —— 只解除复用。
   */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const handle = this.handle
    this.handle = undefined
    if (handle !== undefined) {
      handle.terminate()
      // 等受管进程范围真正空掉，避免快速重启时端口还没释放。
      await handle.waitForExit(AbortSignal.timeout(this.options.config.graceMs + 5000)).catch(() => false)
    }
    this.state = 'stopped'
    this.restarts = 0
  }

  /** 停止后重新启动（用于 `/wb2api-restart`）。 */
  async restart(): Promise<GatewayStatus> {
    await this.stop()
    this.stopping = false
    this.restarts = 0
    return this.start()
  }

  /** 当前状态快照。 */
  status(): GatewayStatus {
    const stderr = this.handle?.collected.stderr?.readFrom(0).text
    return {
      state: this.state,
      baseURL: this.options.config.baseURL,
      port: this.port,
      ...this.resolvedBinary !== undefined ? { binaryPath: this.resolvedBinary } : {},
      ...this.lastError !== undefined ? { lastError: this.lastError } : {},
      restarts: this.restarts,
      ...stderr !== undefined && stderr.length > 0 ? { recentStderr: stderr.slice(-2000) } : {},
    }
  }

  /** 带实时探活的状态快照（供 `/wb2api-status` 使用）。 */
  async statusWithHealth(): Promise<GatewayStatus> {
    const base = this.status()
    // 状态里没有 pid：subprocess 句柄不暴露 pid，用探活结果代替进程存活性判断。
    try {
      const health = await this.probe()
      if (health !== undefined) {
        return { ...base, health, state: base.state === 'stopped' ? 'external' : base.state }
      }
    } catch (error) {
      return { ...base, lastError: error instanceof Error ? error.message : String(error) }
    }
    return base
  }

  /** 安装/卸载用的清理入口：终止全部受管进程，不再重启。 */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }
}
