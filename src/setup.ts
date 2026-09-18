/**
 * 一键就绪：把「能跑起来」所需的全部前置条件按顺序补齐，并逐步汇报。
 *
 * ## 它存在的理由
 *
 * 插件本身只做两件事（托管进程 + 同步模型），但要真正用起来，用户还得先跨过三道门槛：
 * 有二进制、有账号、网关真的能服务。这三件事分散在 README 的「前置条件」里、
 * 各有各的失败方式（找不到可执行文件 / `healthy: 0` / 端口被占），
 * 而每一种失败在 dsh 里看起来都一样：模型请求失败。
 *
 * `/wb2api-setup` 把它们串成一条**有顺序、有汇报、可安全重复执行**的流程：
 *
 * ```
 * ① 定位可执行文件（已有 → 用它；没有 → 下载校验后安装）
 * ② 确认账号（auths/ 里有启用凭证 → 跳过；没有 → 走 OAuth 登录）
 * ③ 启动网关并探活（healthy > 0 才算成功）
 * ④ 刷新模型目录
 * ```
 *
 * ## 为什么「登录」是注入的回调而不是本模块的实现
 *
 * `/wb2api-login` 单独执行时也要走**同一套**登录流程。若在这里再实现一遍，
 * 两处的手感与文案必然漂移（历史上本项目已经因此踩过：状态命令与切换命令各写了一份
 * 选择描述）。所以本模块只负责**编排与汇报**，登录动作由调用方注入，成功与否
 * 都用同一种结果结构回报。
 *
 * ## 设计约束
 *
 * 1. **每一步都可独立失败并如实汇报**，不做「一路 try 到底再报个大错」——
 *    用户需要知道到底卡在哪一步（没二进制 / 没账号 / 账号在冷却）。
 * 2. **永不覆盖用户已有的二进制**：只往插件自己的缓存目录装（见 gateway-binary.ts）。
 * 3. **可重复执行**：第二次跑会直接从第一个未满足的条件继续，不重复已完成的工作。
 *
 * @module dsh-workbuddy2api/setup
 */

import { existsSync } from 'node:fs'
import type { GatewayPluginConfig } from './config.js'
import type { AuthAccount } from './accounts.js'
import type { GatewayStatus } from './gateway-supervisor.js'
import type { GatewayBinaryInstaller, InstallResult } from './gateway-binary.js'
import type { Realm } from './login.js'

/** 步骤状态。 */
export type StepStatus = 'ok' | 'skipped' | 'failed'

/** 一条步骤汇报。 */
export interface SetupStep {
  /** 人类可读的标题。 */
  title: string
  /** 结果状态。 */
  status: StepStatus
  /** 细节（路径、账号数、失败原因…）。 */
  detail: string
}

/** 一次 setup 的结果。 */
export interface SetupOutcome {
  /** 全部步骤（含失败那一步）。 */
  steps: SetupStep[]
  /** 是否达成「网关可服务」。 */
  ready: boolean
  /** 可执行文件路径（拿到时）。 */
  binaryPath?: string
}

/** 注入的登录动作结果：成功带 uid，失败带原因（原因会被原样展示）。 */
export type LoginOutcome =
  | { ok: true; uid?: string }
  | { ok: false; detail: string }

/** 编排依赖（全部注入，便于单测时替换成假实现）。 */
export interface SetupRunnerOptions {
  config: GatewayPluginConfig
  /** 网关进程托管；缺失（无 subprocess 服务）时只做前两步。 */
  supervisor?: {
    resolveBinary: () => Promise<string>
    start: () => Promise<GatewayStatus>
    restart: () => Promise<GatewayStatus>
  }
  /** 账号清单（读 auths/ 目录）。 */
  accountStore: { list: () => AuthAccount[]; authDir: () => string }
  /** 二进制安装器。 */
  installer: Pick<GatewayBinaryInstaller, 'ensure' | 'prepareRuntime'>
  /**
   * 登录动作。`realm` 为 undefined 表示尚未选定登录版本（调用方应先询问用户）；
   * 本模块会把「未选定」当成需要更多信息来汇报，而不是猜一个默认域。
   */
  performLogin: (realm: Realm | undefined) => Promise<LoginOutcome>
  /** 模型目录刷新（成功后强制重取一次）。 */
  refreshModels: () => Promise<unknown>
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

/**
 * 一键就绪编排器。
 *
 * 实例本身无副作用（状态都在 `run()` 的局部变量里），因此可以连续跑多次。
 */
export class SetupRunner {
  constructor(private readonly options: SetupRunnerOptions) {}

  /**
   * 运行目录是否由插件托管。
   *
   * 判定与 `GatewaySupervisor.resolveWorkingDir()` 一致：用户没有显式指定
   * `workingDir` / `repoPath` 时，网关跑在插件的 `~/.dsh/wb2api/`，那份
   * `config.json` 与 `auths/` 由插件负责准备。
   */
  private managesRuntimeDir(): boolean {
    return this.options.config.workingDir === '' && this.options.config.repoPath === ''
  }

  /**
   * 执行完整流程。
   *
   * @param realm - 已确定的 realm（来自命令参数或插件配置）；undefined 时若需要登录，
   *   会在汇报里要求调用方先询问用户，而不是擅自选一个域。
   */
  async run(realm: Realm | undefined): Promise<SetupOutcome> {
    const steps: SetupStep[] = []
    const outcome: SetupOutcome = { steps, ready: false }

    // ① 可执行文件。
    const binary = await this.ensureBinary(steps)
    if (binary === undefined) return outcome
    outcome.binaryPath = binary

    // ② 账号。
    const loggedIn = await this.ensureAccount(steps, realm)
    if (steps.some(step => step.status === 'failed')) return outcome

    // ③ 托管不可用时到此为止：前两步的成果（二进制 + 凭证）本身就有价值。
    if (this.options.supervisor === undefined) {
      steps.push({
        title: '启动网关',
        status: 'failed',
        detail: 'dsh 的 subprocess 服务不可用，无法托管网关进程；请手工启动网关后使用。',
      })
      return outcome
    }

    // ③ 启动并探活。
    const status = await this.startGateway(steps, loggedIn)
    // 进程都没起来就别去拉模型目录了：那只会再叠一条「/v1/models 连接被拒」的噪声，
    // 把真正的失败原因（二进制/端口/账号）埋掉。
    if (status === undefined || status.state === 'failed') return outcome

    // ④ 模型目录（探活没拿到 healthy 也刷新一次：TTL 缓存里可能已有内容）。
    steps.push(await this.refreshCatalogStep())

    outcome.ready = status.health !== undefined && status.health.healthy > 0
    return outcome
  }

  /**
   * ① 确保有可执行文件。
   *
   * 顺序刻意是「先问 supervisor 能否解析」而不是「先看缓存目录存不存在」：
   * 用户可能已经把 `binaryPath` 指向自己编译的产物（甚至带了本地补丁），
   * 那种情况下插件**绝不该**去下载一个来覆盖它。
   */
  private async ensureBinary(steps: SetupStep[]): Promise<string | undefined> {
    const supervisor = this.options.supervisor
    if (supervisor !== undefined) {
      try {
        const path = await supervisor.resolveBinary()
        steps.push({ title: '定位网关可执行文件', status: 'ok', detail: `${path}（已存在，沿用）` })
        // 二进制在位不等于能启动：运行目录（config.json / auths/）可能还没准备
        // —— 对更早版本插件下载的二进制尤其如此（那时还不生成 config.json），
        // 而网关缺配置时是**直接退出**（实测见 gateway-binary.ts 的 ensureRuntimeDir）。
        //
        // 只在「运行目录由插件托管」时补建：用户配了 repoPath / workingDir 就说明
        // 他自己管那份目录（里面已有他的 config.json 与 auths/），此时往
        // ~/.dsh/wb2api 里塞一个用不上的 config.json 只会让人困惑。
        if (this.managesRuntimeDir()) {
          const runtime = this.options.installer.prepareRuntime()
          if (runtime.created || runtime.dirsCreated.length > 0) {
            steps.push({
              title: '准备网关运行目录',
              status: 'ok',
              detail: `${runtime.dir}`
                + `${runtime.created ? `\n已生成 ${runtime.configPath}（随机 api_key，仅监听 127.0.0.1）` : ''}`
                + `${runtime.dirsCreated.length > 0 ? `\n已创建：${runtime.dirsCreated.join('、')}` : ''}`,
            })
          }
        }
        return path
      } catch (error) {
        // 显式配置了 binaryPath 却不存在：这是配置错误，不能靠下载绕过
        // （supervisor 仍会优先用它，下载到别处照样起不来）。
        if (this.options.config.binaryPath !== '') {
          steps.push({
            title: '定位网关可执行文件',
            status: 'failed',
            detail: `${error instanceof Error ? error.message : String(error)}\n`
              + '这是插件配置里显式指定的路径，插件不会擅自改用别处的文件。'
              + '请修正 binaryPath，或把它清空后重新执行本命令（届时会自动下载）。',
          })
          return undefined
        }
        this.options.logger.info(
          `[workbuddy2api] 未找到可执行文件，准备下载：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    let installed: InstallResult
    try {
      installed = await this.options.installer.ensure()
    } catch (error) {
      steps.push({
        title: '下载网关可执行文件',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }

    steps.push({
      title: '下载网关可执行文件',
      status: installed.downloaded ? 'ok' : 'skipped',
      detail: installed.downloaded
        ? `${installed.asset} → ${installed.path}`
          + `（${installed.bytes ?? 0} 字节，sha256 ${(installed.sha256 ?? '').slice(0, 12)}… 校验通过）`
        : `已存在，未重新下载：${installed.path}`,
    })
    // 运行目录（config.json + auths/）单独汇报：它是"二进制有了却起不来"的常见原因，
    // 把它显示出来，用户就能自己判断凭据到底落在哪。
    if (installed.configCreated || installed.dirsCreated.length > 0) {
      steps.push({
        title: '准备网关运行目录',
        status: 'ok',
        detail: `${installed.runtimeDir}`
          + `${installed.configCreated ? `\n已生成 ${installed.configPath}（随机 api_key，仅监听 127.0.0.1）` : ''}`
          + `${installed.dirsCreated.length > 0 ? `\n已创建：${installed.dirsCreated.join('、')}` : ''}`,
      })
    }
    if (!existsSync(installed.path)) {
      steps.push({ title: '校验安装结果', status: 'failed', detail: `安装后仍找不到 ${installed.path}` })
      return undefined
    }
    return installed.path
  }

  /**
   * ② 确保有启用中的账号；没有就走一次登录。
   *
   * @returns 是否**本次新登录**（决定启动网关时用 start 还是 restart —— 网关只在
   *   启动时扫 `auths/`，新凭证必须靠重启才会被加载）。
   */
  private async ensureAccount(steps: SetupStep[], realm: Realm | undefined): Promise<boolean> {
    const authDir = this.options.accountStore.authDir()
    const existing = this.options.accountStore.list().filter(item => item.enabled)
    if (existing.length > 0) {
      const names = existing
        .map(item => `${item.nickname !== '' ? item.nickname : '(无昵称)'}·${item.realm}`)
        .join('、')
      steps.push({
        title: '检查账号',
        status: 'skipped',
        detail: `auths/ 里已有 ${existing.length} 个启用中的账号（${names}），跳过登录。${authDir}`,
      })
      return false
    }

    const result = await this.options.performLogin(realm)
    if (!result.ok) {
      steps.push({ title: '登录账号', status: 'failed', detail: result.detail })
      return false
    }

    // 复核目录最终形态，而不是相信登录动作的返回值：禁用态后缀、文件名规则
    // 都可能导致「登录成功但网关看不见」，只有重新扫描才等价于网关重启后读到的东西。
    const enabled = this.options.accountStore.list().filter(item => item.enabled)
    if (enabled.length === 0) {
      steps.push({
        title: '登录账号',
        status: 'failed',
        detail: `登录流程报告成功，但 ${authDir} 里仍没有启用中的凭证文件。`
          + '请检查该目录的写入权限，或用 /wb2api-account auto 确认没有全部账号处于禁用态。',
      })
      return false
    }
    const account = enabled.find(item => item.uid === result.uid) ?? enabled[0]!
    steps.push({
      title: '登录账号',
      status: 'ok',
      detail: `${account.nickname !== '' ? account.nickname : '(无昵称)'} · ${account.realm}`
        + `（当前启用 ${enabled.length} 个账号）`,
    })
    return true
  }

  /**
   * ③ 启动网关；刚登录过就走 restart 语义。
   *
   * 新登录的凭证落在 `auths/` 里。较新的网关（含本插件 Release 的二进制）有 5 秒
   * 轮询热加载，理论上能自己发现；但**旧版自编译二进制没有**（只在启动时 `LoadDir`
   * 一次），而且热加载依赖「启动时 `auths/` 目录已存在」，否则监听会被永久跳过。
   * 因此刚写完凭证就重启一次，让两条路径都必然生效 —— 代价只是启动流程里的一次重启。
   */
  private async startGateway(steps: SetupStep[], justLoggedIn: boolean): Promise<GatewayStatus | undefined> {
    const supervisor = this.options.supervisor
    if (supervisor === undefined) return undefined
    try {
      const status = justLoggedIn ? await supervisor.restart() : await supervisor.start()

      if (status.state === 'failed') {
        steps.push({
          title: '启动网关',
          status: 'failed',
          detail: `${status.lastError ?? '未知原因'}`
            + `${status.recentStderr !== undefined ? `\n网关 stderr：\n${status.recentStderr.trimEnd()}` : ''}`,
        })
        return status
      }

      const health = status.health
      const label: Record<string, string> = {
        running: '运行中',
        unhealthy: '运行中（无可用账号）',
        external: '复用端口上已有的网关',
        starting: '启动中',
        stopped: '未运行',
      }
      const lines = [
        `${label[status.state] ?? status.state} · ${status.baseURL}`,
        health !== undefined
          ? `账号可用性：${health.healthy}/${health.total}`
            + `${health.realmServable !== undefined
              ? `（域：${Object.entries(health.realmServable).map(([k, v]) => `${k}=${v ? '可用' : '不可用'}`).join(' ')}）`
              : ''}`
          : '探活未返回 /healthz（网关可能仍在启动）',
      ]
      const healthy = health !== undefined && health.healthy > 0
      if (!healthy) {
        lines.push('网关进程在跑，但当前没有可用账号：新登录的账号可能刚过期或正在冷却，稍后会自动恢复；'
          + '也可用 /wb2api-status 查看逐号状态。')
      }
      steps.push({ title: '启动网关', status: healthy ? 'ok' : 'failed', detail: lines.join('\n') })
      return status
    } catch (error) {
      steps.push({
        title: '启动网关',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /** ④ 刷新模型目录（失败不算致命：模型列表有 TTL 缓存，下次用到会重取）。 */
  private async refreshCatalogStep(): Promise<SetupStep> {
    try {
      const models = await this.options.refreshModels() as { length?: number } | undefined
      const count = typeof models?.length === 'number' ? models.length : undefined
      return {
        title: '同步模型目录',
        status: 'ok',
        detail: count !== undefined ? `已从 /v1/models 拉取 ${count} 个模型` : '已刷新',
      }
    } catch (error) {
      return {
        title: '同步模型目录',
        status: 'failed',
        detail: `${error instanceof Error ? error.message : String(error)}`
          + '（不影响网关本体；重启 dsh 或在模型选择器里刷新即可重试）',
      }
    }
  }
}

/** 把结果渲染成命令回执（成功/失败两种 kind 由调用方决定）。 */
export function renderSetupReport(outcome: SetupOutcome): string {
  const icon: Record<StepStatus, string> = { ok: '✓', skipped: '·', failed: '✗' }
  const lines = ['workbuddy2api 一键就绪：', '']
  outcome.steps.forEach((step, index) => {
    lines.push(`${icon[step.status]} ${index + 1}. ${step.title}`)
    for (const line of step.detail.split('\n')) lines.push(`    ${line}`)
  })
  lines.push('')
  lines.push(outcome.ready
    ? '全部就绪：现在可以在模型选择器里选 workbuddy2api 的模型直接对话。'
    : '尚未就绪：请按上面标 ✗ 的步骤处理后重跑 /wb2api-setup。')
  return lines.join('\n')
}
