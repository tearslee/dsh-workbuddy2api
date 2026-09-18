/**
 * dsh 插件入口：注册 provider 路由、托管网关进程、提供管理命令。
 *
 * 三块职责：
 *   ① 进程托管 —— `GatewaySupervisor` 拉起 wb2api 并绑定生命周期；
 *   ② provider —— 注册 `workbuddy2api` 路由，`listModels`/`resolveModel` 打 `/v1/models`；
 *   ③ 管理面 —— `/wb2api-status` / `/wb2api-start` / `/wb2api-restart` / `/wb2api-login`。
 *
 * 职责边界：协议适配、账号池、熔断、定时任务全部留在 Go 侧。插件只解决
 * 「进程生命周期」与「模型目录自动化」两件事。
 *
 * @module dsh-workbuddy2api
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import Schema from '@deepseek-ai/schemastery'
import { resolveConfig, gatewayOrigin, PROVIDER, SETTINGS_NS, type GatewayPluginConfig } from './config.js'
import { mapModelCatalog, ModelCatalog } from './models.js'
import { GatewayAdapter } from './gateway-adapter.js'
import { GatewaySupervisor } from './gateway-supervisor.js'
import {
  AccountStore,
  parseAccountSelector,
  planRenames,
  type AccountSelection,
  type AuthAccount,
} from './accounts.js'
import { GatewayBinaryInstaller, defaultRuntimeDir } from './gateway-binary.js'
import {
  buildAuthFile,
  LoginClient,
  LoginPendingError,
  parseRealmArg,
  realmEndpoints,
  writeAuthFile,
  type Realm,
} from './login.js'
import { renderSetupReport, SetupRunner } from './setup.js'

export { Config, DEFAULT_CONFIG, resolveConfig, PROVIDER, SETTINGS_NS } from './config.js'
export type { GatewayPluginConfig, RealmPrefixPolicy } from './config.js'
export { GatewayAdapter } from './gateway-adapter.js'
export { GatewaySupervisor } from './gateway-supervisor.js'
export { ModelCatalog, mapModelCatalog, mapModel, parseModelId, toWireModel } from './models.js'
export {
  AccountStore,
  DISABLED_SUFFIX,
  parseAccountSelector,
  planRenames,
  shouldEnable,
} from './accounts.js'
export type { AccountRename, AccountSelection, AuthAccount, SelectionResult } from './accounts.js'
export {
  assetName,
  binaryFileName,
  currentTarget,
  defaultInstallDir,
  GatewayBinaryInstaller,
  parseChecksums,
  sha256,
} from './gateway-binary.js'
export {
  buildAuthFile,
  inferRealm,
  LoginClient,
  LoginPendingError,
  loginHeaders,
  parseRealmArg,
  realmEndpoints,
  resolveRealmInput,
  writeAuthFile,
} from './login.js'
export type { AuthFileDocument, LoginResult, Realm } from './login.js'
export { renderSetupReport, SetupRunner } from './setup.js'
export type { SetupOutcome, SetupStep, StepStatus } from './setup.js'
export { extractFile, listEntries, ZipError } from './zip.js'

/** 插件实例 id。必须与 `cordis.patch.yml` 里的 `id` 一致。 */
export const name = 'workbuddy2api'

/**
 * 依赖的服务。
 *
 * 只注入真正必需的三个：`llm` 注册适配器、`subprocess` 托管进程、`commands` 注册
 * 斜杠命令。`settings` 与 `credentials` 走 `ctx.get()` 按需取 —— 它们在 web profile
 * 里恒存在，但缺失时插件仍应能加载（只是模型设置页少一个 namespace 地址）。
 */
export const inject = ['llm', 'subprocess', 'commands']

/**
 * provider 配置 namespace 的 schema。
 *
 * `registerConfigurableProviders` 声明的 `settingsNs` 必须真实存在于 settings
 * 服务中，否则模型设置页读到 undefined 的 namespace，在
 * `refFor → deriveKeyRef(provider)` 处会以 `provider.toUpperCase is not a function`
 * 崩溃。
 *
 * **注意**：`settings.register()` 要求 schemastery schema —— `describe()` 会对每个
 * 注册项无条件调用 `schema.toJSON()` 与 `redactSecrets(schema, value)`。传入裸函数
 * （`(value) => ...`）会让 `describe()` 抛
 * `TypeError: registration.schema.toJSON is not a function`，进而使所有依赖 settings
 * 的界面（模型设置页、主题、sidebar 的 settings.get/shell.get）全部失败。
 * 因此这里**必须**用 `Schema.object({...})` 构造。
 */
const providerSettingsSchema = Schema.object({
  providers: Schema.dict(Schema.any()).default({}),
})

/** 注册 provider 配置 namespace（已存在时忽略重复注册错误）。 */
function registerProviderSettings(ctx: Context): void {
  const settings = ctx.get('settings') as
    | {
      register: (ns: string, schema: unknown) => unknown
      describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string }>
    }
    | undefined
  if (settings === undefined || typeof settings.register !== 'function') {
    ctx.logger.warn('[workbuddy2api] settings 服务不可用，provider namespace 未注册')
    return
  }
  try {
    settings.register(SETTINGS_NS, providerSettingsSchema)
  } catch (error) {
    ctx.logger.warn(`[workbuddy2api] settings namespace "${SETTINGS_NS}" 注册失败: ${String(error)}`)
    return
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
    const registered = descriptors.map(item => item.ns)
    if (!registered.includes(SETTINGS_NS)) {
      ctx.logger.warn(`[workbuddy2api] provider namespace 未生效: ${SETTINGS_NS}`)
    }
  } catch (error) {
    ctx.logger.error(
      '[workbuddy2api] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: '
      + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

/**
 * 从 dsh 凭据库或环境变量解析网关 api_key。
 *
 * 解析顺序：dsh 凭据库（`~/.dsh/.credentials.yaml` 的 `refs`）→ 同名环境变量 →
 * 网关自己的 `config.json`。三层是**依次降级**关系，保证「同机部署」这种最常见
 * 情形（网关与 dsh 同在一台机器）零额外配置即可工作。
 */
async function makeApiKeyResolver(ctx: Context, config: GatewayPluginConfig): Promise<() => Promise<string | undefined>> {
  const ref = config.apiKeyRef
  // 动态 import：@deepseek-ai/dsh-credentials 在 profile 里恒存在，但把它变成硬依赖
  // 会让插件在缺少该服务的组合里加载失败。拿不到时静默降级到环境变量/配置文件。
  // 这里用变量形式的说明符，避免 tsc 在本包未声明该依赖时直接报 TS2307。
  let toRef: ((value: string) => unknown) | undefined
  try {
    const specifier: string = '@deepseek-ai/dsh-credentials'
    const mod = await import(specifier) as { credentialRef?: (value: string) => unknown }
    toRef = mod.credentialRef
  } catch {
    toRef = undefined
  }

  return async () => {
    if (ref.length > 0 && toRef !== undefined) {
      const credentials = ctx.get('credentials') as
        | { resolve?: (ref: unknown) => Promise<{ value?: string } | undefined> }
        | undefined
      if (credentials?.resolve !== undefined) {
        try {
          const resolved = await credentials.resolve(toRef(ref))
          if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
            return resolved.value
          }
        } catch (error) {
          ctx.logger.warn(
            `[workbuddy2api] 读取凭据 ${ref} 失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
    if (ref.length > 0) {
      const fromEnv = process.env[ref]
      if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
    }
    // 最后回退：直接读网关自身的 config.json（同机部署时无需重复配置凭据）。
    return readApiKeyFromGatewayConfig(config)
  }
}

/**
 * 从网关 `config.json` 读取 `api_key`（同机部署时无需重复配置凭据）。
 *
 * 候选路径要和「网关实际的工作目录」一致（见 supervisor 的 `resolveWorkingDir`）：
 * `workingDir` → `repoPath` → 插件运行目录。少最后一条会导致**自动下载二进制的用户
 * 永远读不到 api_key** —— 那份 config.json 是我们自己生成在运行目录里的。
 */
function readApiKeyFromGatewayConfig(config: GatewayPluginConfig): string | undefined {
  const candidates: string[] = []
  if (config.workingDir.length > 0) candidates.push(join(config.workingDir, 'config.json'))
  if (config.repoPath.length > 0) candidates.push(join(config.repoPath, 'config.json'))
  candidates.push(join(defaultRuntimeDir(), 'config.json'))
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      // 同步读：只在凭据解析路径上调用一次，且文件很小。
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { api_key?: unknown }
      if (typeof parsed.api_key === 'string' && parsed.api_key.length > 0) return parsed.api_key
    } catch {
      // 忽略：继续尝试下一个候选。
    }
  }
  return undefined
}

/** 毫秒级等待（登录轮询用；不引第三方依赖）。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * 记录一次「provider 路由被外部配置占用」的注册失败。
 *
 * 两种占用的实际报错不同（目录声明 vs 适配器），但排障动作完全一样，
 * 所以统一在这里附带迁移指引，避免两处文案漂移。
 *
 * @param ctx - 插件上下文（取 logger）。
 * @param what - 失败的是哪一步（'provider 目录' / '适配器'）。
 * @param error - 捕获到的错误。
 */
function logRouteConflict(ctx: Context, what: string, error: unknown): void {
  const code = (error as { code?: string }).code
  ctx.logger.error(
    `[workbuddy2api] ${what}注册被拒`
    + `${code !== undefined ? `（${code}）` : ''}：${error instanceof Error ? error.message : String(error)}`,
  )
}

/** 把状态快照渲染成命令输出文本。 */function renderStatus(status: Awaited<ReturnType<GatewaySupervisor['statusWithHealth']>>, authFiles: number): string {
  const stateText: Record<string, string> = {
    stopped: '未运行',
    external: '复用外部已运行的网关',
    starting: '启动中',
    running: '运行中',
    unhealthy: '运行中（无可用账号）',
    failed: '失败',
  }
  const lines = [
    `状态: ${stateText[status.state] ?? status.state}`,
    `端点: ${status.baseURL}`,
  ]
  if (status.binaryPath !== undefined) lines.push(`可执行文件: ${status.binaryPath}`)
  if (status.health !== undefined) {
    lines.push(`账号: ${status.health.healthy}/${status.health.total} 可用`)
    if (status.health.realmServable !== undefined) {
      const realms = Object.entries(status.health.realmServable)
        .map(([realm, servable]) => `${realm}=${servable ? '可用' : '不可用'}`)
        .join(' ')
      lines.push(`域: ${realms}`)
    }
  } else {
    lines.push('账号: 探活失败（网关未响应 /healthz）')
  }
  lines.push(`本地 auths/ 凭证文件: ${authFiles} 个`)
  if (status.restarts > 0) lines.push(`自动重启次数: ${status.restarts}`)
  if (status.lastError !== undefined) lines.push(`最近错误: ${status.lastError}`)
  if (status.health !== undefined && status.health.healthy === 0) {
    lines.push('提示: 网关已启动但没有可用账号，请执行 /wb2api-login 完成登录。')
  }
  if (status.recentStderr !== undefined) {
    lines.push('', '网关 stderr（尾部）:', status.recentStderr.trimEnd())
  }
  return lines.join('\n')
}

/**
 * dsh user-questions 服务的最小接口。
 *
 * 类型刻意**本地声明**而不 import `@deepseek-ai/dsh-user-questions`：该包在 profile 里
 * 恒存在（`dsh-tool-ask-user` / `dsh-client-ui-user-questions` 都依赖它），但不在本插件的
 * `package.json` 里，直接 import 类型会让 tsc 报 TS2307；把它加成硬依赖又会让插件在
 * 缺该服务的组合里加载失败。取法与本文件 `makeApiKeyResolver` 对 credentials 的处理一致。
 *
 * `ask` 需要传 **agent**（命令处理器能拿到），且该 agent 必须是注册表里的 live runtime root：
 * 子 agent 没有人类应答者，`ask` 会以 `DELEGATED_CALLER` 失败 —— 命令层据此降级为文本列表。
 */
interface UserQuestionsService {
  ask: (request: {
    questions: Array<{
      id: string
      question: string
      detail?: string
      header?: string
      options?: Array<{ label: string; description?: string }>
    }>
    agent?: unknown
    signal?: AbortSignal
  }) => Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
}

/** 网关 `/status` 里单个账号的实时字段（其余字段本插件不使用）。 */
interface GatewayAccountStatus {
  uid?: unknown
  realm?: unknown
  nickname?: unknown
  credits?: unknown
  cooling?: unknown
  cool_kind?: unknown
  cool_remaining_sec?: unknown
  disabled?: unknown
}

/**
 * 拉取网关 `/status`（**需要鉴权**，与免鉴权的 `/healthz` 不同）。
 *
 * 失败一律返回 undefined 而不是抛错：状态/切换命令的主体信息来自本地凭证文件，
 * 实时字段只是锦上添花，不该让整个命令因为一次探活失败而不可用。
 */
async function fetchGatewayStatus(
  baseURL: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`${gatewayOrigin(baseURL)}/status`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {},
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    return await response.json() as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 把 `/status.accounts` 索引进 uid → 实时字段。 */
function indexGatewayAccounts(status: Record<string, unknown> | undefined): Map<string, GatewayAccountStatus> {
  const out = new Map<string, GatewayAccountStatus>()
  const raw = status?.accounts
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as GatewayAccountStatus
    if (typeof entry.uid === 'string') out.set(entry.uid, entry)
  }
  return out
}

/** uid 的短标识：`oneid_1470660413338166550` → `…166550`（弹窗与列表里避免整串刷屏）。 */
function shortUid(uid: string): string {
  return uid.length > 7 ? `…${uid.slice(-6)}` : uid
}

/** 秒数渲染成「N 分 M 秒」。 */
function formatRemaining(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '0 秒'
  const total = Math.ceil(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}

/** 单个账号的一行描述（本地文件信息 + 网关实时字段）。 */
function describeAccount(account: AuthAccount, live: GatewayAccountStatus | undefined): string {
  const head = `${account.nickname !== '' ? account.nickname : '(无昵称)'} · ${shortUid(account.uid)} · ${account.realm}`
  if (!account.enabled) return `${head} · 已禁用（网关未加载，积分未知）`
  if (live === undefined) return `${head} · 网关未上报（刚启动或不在池中）`
  const bits: string[] = []
  if (typeof live.credits === 'number') bits.push(`积分 ${live.credits}`)
  if (live.disabled === true) bits.push('网关侧已禁用')
  else if (live.cooling === true) {
    bits.push(`冷却中（${typeof live.cool_kind === 'string' ? live.cool_kind : 'unknown'}，剩 ${formatRemaining(live.cool_remaining_sec)}）`)
  } else bits.push('可用')
  return `${head} · ${bits.join(' · ')}`
}

/** 人话描述当前选择（命令回执与状态命令共用，避免两处文案漂移）。 */
function describeSelection(accounts: AuthAccount[], enabled: AuthAccount[]): string {
  if (enabled.length === accounts.length || enabled.length === 0) return '自动（全部账号参与轮换）'
  return `仅 ${enabled.map(a => `${a.nickname !== '' ? a.nickname : shortUid(a.uid)}(${shortUid(a.uid)})`).join('、')}`
}

/**
 * 账号段：凭证文件形态（启用/禁用）+ 网关实时字段。
 *
 * 刻意把「文件层」与「网关层」分开显示 —— 二者不一致本身就是最有用的诊断信号
 * （例如文件已启用但网关未上报 = 改名后没重启，或该文件已损坏）。
 */
function renderAccountSection(
  authDir: string,
  accounts: AuthAccount[],
  live: Record<string, unknown> | undefined,
): string[] {
  const liveByUid = indexGatewayAccounts(live)
  const enabled = accounts.filter(a => a.enabled)
  const disabled = accounts.filter(a => !a.enabled)
  const lines = [
    `账号文件: ${enabled.length} 启用 / ${disabled.length} 已禁用（${authDir}）`,
    `当前模式: ${describeSelection(accounts, enabled)}`,
  ]
  for (const account of accounts) {
    lines.push(`  ${account.enabled ? '✓' : '✗'} ${describeAccount(account, liveByUid.get(account.uid))}`)
  }
  if (disabled.length > 0) {
    lines.push('提示: 已禁用的账号不由网关加载（期间 token 不刷新）；恢复全部用 /wb2api-account auto')
  }
  return lines
}

/**
 * 插件主体。
 *
 * @param ctx - cordis 上下文。
 * @param rawConfig - 组合层传入的插件配置（可能不完整）。
 */
export function apply(ctx: Context, rawConfig?: Partial<GatewayPluginConfig>): void {
  const config = resolveConfig(rawConfig)

  // provider 的 settingsNs 必须已注册，否则模型设置页会因未注册 namespace 崩溃。
  registerProviderSettings(ctx)

  const subprocess = ctx.get('subprocess') as SubprocessRuntime | undefined
  if (subprocess === undefined) {
    ctx.logger.error('[workbuddy2api] subprocess 服务不可用，网关进程无法托管；provider 仍会注册。')
  }

  const supervisor = subprocess !== undefined
    ? new GatewaySupervisor({ config, subprocess, logger: ctx.logger })
    : undefined

  // 账号开关（auths/ 凭证文件重命名）。只做文件读写，因此 subprocess 缺失时照样可构造
  // ——那种环境下命令会明确报「无法托管网关进程」而不是静默什么都不做。
  const accountStore = new AccountStore({ config, logger: ctx.logger })

  // 预编译二进制的获取（`/wb2api-setup` 在缺货时调用；见 gateway-binary.ts）。
  // installDir 与 runtimeDir 分工：`bin/` 放可执行文件，根目录放 config.json 与 auths/。
  const installer = new GatewayBinaryInstaller({
    repo: config.binaryReleaseRepo,
    releaseBase: config.binaryReleaseBase,
    listenPort: config.listenPort,
    logger: ctx.logger,
  })

  // 登录客户端（`/wb2api-login` 与 `/wb2api-setup` 共用同一条流程）。
  const loginClient = new LoginClient()

  // 界面化选择经由 dsh 的 user-questions 服务；缺失时命令降级为文本列表 + 参数用法。
  const userQuestions = ctx.get('userQuestions') as UserQuestionsService | undefined

  // 凭据解析在异步初始化完成后填充；catalog 与 adapter 都通过闭包读取它。
  let apiKeyResolver: () => Promise<string | undefined> = async () => undefined

  const catalog = new ModelCatalog({
    ttlMs: config.modelsTtlSeconds * 1000,
    fetchCatalog: async () => {
      const apiKey = await apiKeyResolver()
      const response = await fetch(`${config.baseURL}/models`, {
        headers: {
          accept: 'application/json',
          ...apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {},
        },
        signal: AbortSignal.timeout(config.healthTimeoutSeconds * 1000),
      })
      if (!response.ok) {
        throw new Error(`GET /v1/models 返回 HTTP ${response.status}`)
      }
      return mapModelCatalog(await response.json(), config.realmPrefixPolicy)
    },
  })

  const adapter = new GatewayAdapter({
    providerId: PROVIDER,
    baseURL: config.baseURL,
    catalog,
    resolveApiKey: () => apiKeyResolver(),
    requestTimeoutMs: config.requestTimeoutSeconds * 1000,
    idleTimeoutMs: config.idleTimeoutSeconds * 1000,
    firstTokenTimeoutMs: config.firstTokenTimeoutSeconds * 1000,
    readImage: async (attachment) => {
      const attachments = ctx.get('attachments') as
        | { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> }
        | undefined
      if (attachments?.readImage === undefined) return undefined
      try {
        const stored = await attachments.readImage(attachment as never)
        return { data: stored.data, mediaType: stored.ref.mediaType }
      } catch {
        return undefined
      }
    },
  })

  // 凭据解析是异步初始化（动态 import），完成后适配器即可读到。
  void makeApiKeyResolver(ctx, config).then((resolver) => { apiKeyResolver = resolver })

  // ① provider 目录 + 适配器注册。
  //
  // 两处注册都可能在「settings.yaml 里仍留着 llm-pi-ai.providers.workbuddy2api」时
  // 失败（就是「装了插件但还没做迁移」）：
  //   - registerConfigurableProviders → `configurable provider "workbuddy2api" is already declared`
  //   - registerAdapter               → `an adapter for provider "workbuddy2api" is already registered`
  //     （code = DUPLICATE_ADAPTER，消息里不含 code 字样）
  //
  // 这里**故意捕获后只记日志、不向上抛**。那种状态下旧配置本来工作正常，若抛错会让整个
  // dsh 起不来，把一个可用环境变成完全不可用。降级后：dsh 照常启动、模型仍走 settings.yaml
  // 里那份手工配置，而日志与 `/wb2api-status` 都明确指出该删哪一段。
  let routeOwnedByOther = false

  try {
    // 让模型设置页知道这条路由存在（即使尚未激活）。
    ctx.llm.registerConfigurableProviders([
      {
        provider: PROVIDER,
        displayName: 'WorkBuddy (workbuddy2api 网关)',
        settingsNs: SETTINGS_NS,
        settingsPath: ['providers', PROVIDER],
        // 这条路由是插件自带的，不是用户手写的配置声明。
        declared: false,
      },
    ])
  } catch (error) {
    routeOwnedByOther = true
    logRouteConflict(ctx, 'provider 目录', error)
  }

  try {
    ctx.llm.registerAdapter([PROVIDER], adapter)
  } catch (error) {
    routeOwnedByOther = true
    logRouteConflict(ctx, '适配器', error)
  }

  if (routeOwnedByOther) {
    ctx.logger.error(
      `[workbuddy2api] provider 路由 "${PROVIDER}" 由外部配置占用（见上条）。`
      + '请删除 ~/.dsh/settings.yaml 里的 llm-pi-ai.providers.workbuddy2api 段后重启 dsh；'
      + 'provider id 相同，agent-default-model / subagent-model-selection 的引用无需改动。'
      + '在删除之前，模型请求仍走 settings.yaml 里那份手工配置。',
    )
  }

  // ② 管理命令。
  ctx.commands.register({
    name: 'wb2api-status',
    description: '显示 workbuddy2api 网关状态、账号清单与可用性、模型数量',
    handler: async (): Promise<CommandResult> => {
      try {
        if (supervisor === undefined) {
          return { kind: 'error', text: 'subprocess 服务不可用，无法托管网关进程。' }
        }
        const status = await supervisor.statusWithHealth()
        const models = await catalog.get()
        const authFiles = supervisor.countAuthFiles()
        const inventory = accountStore.list()
        // 实时字段要单独打 /status（healthz 只给汇总数字）；失败不阻断本命令。
        const live = await fetchGatewayStatus(config.baseURL, await apiKeyResolver(), config.healthTimeoutSeconds * 1000)
        const modelLine = models.length > 0
          ? `\n模型目录: ${models.length} 个（示例: ${models.slice(0, 5).map(model => model.id).join(', ')}${models.length > 5 ? ', …' : ''}）`
          : `\n模型目录: 拉取失败${catalog.lastError !== undefined ? `（${catalog.lastError}）` : ''}`
        const accountLines = inventory.length > 0
          ? `\n\n${renderAccountSection(accountStore.authDir(), inventory, live).join('\n')}`
          : `\n\n账号文件: 0 个（${accountStore.authDir()}）—— 先跑 ./login.sh 完成登录`
        // 路由被占用的状态必须显式暴露：此时插件托管了网关，但模型请求走的是
        // settings.yaml 里那份手工配置 —— 不说清楚会让人以为插件没生效。
        const routeLine = routeOwnedByOther
          ? `\n\n⚠ provider 路由 "${PROVIDER}" 未由本插件注册（已被 settings.yaml 占用）。`
            + '\n请删除 ~/.dsh/settings.yaml 里的 llm-pi-ai.providers.workbuddy2api 段后重启 dsh。'
          : ''
        return { kind: 'success', text: renderStatus(status, authFiles) + modelLine + accountLines + routeLine }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'wb2api-start',
    description: '启动 workbuddy2api 网关（幂等：已在运行则直接复用）',
    handler: async (): Promise<CommandResult> => {
      try {
        if (supervisor === undefined) return { kind: 'error', text: 'subprocess 服务不可用。' }
        const status = await supervisor.start()
        if (status.state === 'external') {
          return { kind: 'success', text: `端口上已有健康网关，直接复用：${status.baseURL}` }
        }
        if (status.state === 'failed') {
          return { kind: 'error', text: `启动失败：${status.lastError ?? '未知原因'}` }
        }
        const health = status.health
        return {
          kind: 'success',
          text: `网关已启动：${status.baseURL}`
            + `\n可执行文件: ${status.binaryPath ?? '(未知)'}`
            + `\n账号: ${health !== undefined ? `${health.healthy}/${health.total} 可用` : '未探到'}`
            + `${health !== undefined && health.healthy === 0 ? '\n提示: 没有可用账号，请执行 /wb2api-login。' : ''}`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'wb2api-restart',
    description: '重启 workbuddy2api 网关并刷新模型目录',
    handler: async (): Promise<CommandResult> => {
      try {
        if (supervisor === undefined) return { kind: 'error', text: 'subprocess 服务不可用。' }
        const status = await supervisor.restart()
        await catalog.get(true)
        return {
          kind: status.state === 'failed' ? 'error' : 'success',
          text: status.state === 'failed'
            ? `重启失败：${status.lastError ?? '未知原因'}`
            : `网关已重启：${status.baseURL}（模型目录已刷新）`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'wb2api-login',
    description: '登录一个 WorkBuddy 账号（浏览器授权，凭证写入 auths/）',
    input: { hint: '[cn | global]' },
    handler: async ({ agent, rawInput }): Promise<CommandResult> => {
      try {
        const realm = await resolveLoginRealm(rawInput, agent)
        const result = await runLogin(realm, agent)
        return result.ok
          ? { kind: 'success', text: result.text }
          : { kind: 'error', text: result.text }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  /**
   * 一套登录流程，`/wb2api-login` 与 `/wb2api-setup` 共用。
   *
   * 之所以抽成函数而不是各写一遍：两处的**顺序**与**失败语义**完全一致，
   * 分开写必然漂移（本项目在「选择描述」上已经踩过一次同样的坑）。
   *
   * 流程：申请授权链接 → 展示给用户并等待确认 → 轮询上游 → 原子落盘 → 重启网关。
   * 网关只在**启动时**扫描 `auths/`，所以最后必须 restart，否则新账号对网关不存在。
   */
  const runLogin = async (realm: Realm, agent: unknown): Promise<{ ok: boolean; text: string }> => {
    const authDir = accountStore.authDir()
    let state: { state: string; authUrl: string }
    try {
      state = await loginClient.begin(realm)
    } catch (error) {
      return {
        ok: false,
        text: `无法向上游申请授权链接：${error instanceof Error ? error.message : String(error)}\n`
          + `（该步骤需要访问上游 OAuth 服务：${realmEndpoints(realm).base}）`,
      }
    }

    const proceed = await confirmAuthUrl(state.authUrl, realm, agent)
    if (!proceed) return { ok: false, text: '已取消授权，未写入任何凭证。' }

    // 用户刚点完「已完成」时上游可能还没认账（登录态写入有延迟），因此轮询重试。
    const attempts = 20
    const intervalMs = 3000
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await loginClient.complete(realm, state.state)
        if (result.account.uid === '') {
          throw new Error('上游返回的账号信息里没有 uid，无法确定凭证文件名。')
        }
        const file = writeAuthFile(authDir, buildAuthFile(result))
        const checkin = await loginClient.checkin(realm, result.token, result.account)
        // 重启失败不当作登录失败：凭证已经落盘，失败原因照实说明即可。
        let restartLine = '网关未由本插件托管（subprocess 不可用），请手工重启网关以加载新账号。'
        if (supervisor !== undefined) {
          try {
            const status = await supervisor.restart()
            restartLine = status.state === 'failed'
              ? `网关重启失败（${status.lastError ?? '未知原因'}）；凭证已写入，可稍后执行 /wb2api-start 重试。`
              : '已重启，新账号已加载'
                + `${status.health !== undefined ? ` · 账号可用性 ${status.health.healthy}/${status.health.total}` : ''}`
          } catch (error) {
            restartLine = `网关重启失败（${error instanceof Error ? error.message : String(error)}）；`
              + '凭证已写入，可稍后执行 /wb2api-start 重试。'
          }
        }
        return {
          ok: true,
          text: [
            `登录成功：${result.account.nickname !== '' ? result.account.nickname : '(无昵称)'} · ${result.realm}`,
            `凭证文件：${file}`,
            `${checkin !== undefined ? `签到：${checkin}` : ''}`,
            `网关：${restartLine}`,
            '',
            '下一步：在聊天窗口的模型选择器里选一个 workbuddy2api 模型即可开始对话。',
          ].filter(line => line !== '').join('\n'),
        }
      } catch (error) {
        lastError = error
        if (!(error instanceof LoginPendingError)) break
        if (attempt < attempts) await sleep(intervalMs)
      }
    }

    return lastError instanceof LoginPendingError
      ? {
        ok: false,
        text: `等待授权超时（${Math.round((intervalMs * attempts) / 1000)} 秒内上游始终未确认登录）。\n`
          + '请确认浏览器里已经点完授权并看到成功提示，然后重跑 /wb2api-login（授权链接每次都会重新生成）。',
      }
      : { ok: false, text: `登录失败：${lastError instanceof Error ? lastError.message : String(lastError)}` }
  }

  /** 解析 realm：命令参数 > 插件配置 `defaultRealm` > 询问用户。 */
  const resolveLoginRealm = async (rawInput: string, agent: unknown): Promise<Realm> => {
    const fromArg = parseRealmArg(rawInput)
    if (fromArg !== undefined) return fromArg
    if (config.defaultRealm === 'cn' || config.defaultRealm === 'global') return config.defaultRealm
    return chooseRealmFromMenu(agent)
  }

  /** 弹窗选择登录版本（国内版 / 国际版）。 */
  const chooseRealmFromMenu = async (agent: unknown): Promise<Realm> => {
    if (userQuestions?.ask === undefined) {
      throw new Error(
        '需要指定登录版本：/wb2api-login cn（国内版）或 /wb2api-login global（国际版）。\n'
        + '（dsh 的 user-questions 服务不可用，无法弹出选择列表。）',
      )
    }
    const labels = new Map<string, Realm>([
      ['国内版（codebuddy.cn / copilot.tencent.com）', 'cn'],
      ['国际版（workbuddy.ai）', 'global'],
    ])
    const answer = await userQuestions.ask({
      questions: [{
        id: 'wb2api-realm',
        question: '登录哪个版本？',
        header: '登录版本',
        detail: '国内外账号体系相互独立：用哪个版本的账号，就选哪一项。'
          + '选错不影响已有凭证，重跑本命令即可。',
        options: [...labels].map(([label]) => ({ label })),
      }],
      // 命令处理器拿到的是**当前 agent**（live runtime root），弹窗必须带上它；
      // 子 agent 没有人类应答者，ask 会以 DELEGATED_CALLER 失败。
      agent,
    })
    const selected = answer.answers[0]?.selected[0]
    const realm = selected !== undefined ? labels.get(selected) : undefined
    if (realm === undefined) {
      throw new Error('未选择登录版本。请用 /wb2api-login cn 或 /wb2api-login global 明确指定。')
    }
    return realm
  }

  /**
   * 把授权链接交给用户，并等待他确认「已经在浏览器里完成」。
   *
   * 有 user-questions 服务时弹一个带链接的确认框；没有时退回文本提示
   * （链接照常可见，用户自行打开后重跑命令 —— 此时会重新生成 state，
   * 因此轮询那一步必然拿不到旧 state 的结果，属于可接受的降级）。
   */
  const confirmAuthUrl = async (authUrl: string, realm: Realm, agent: unknown): Promise<boolean> => {
    ctx.logger.info(`[workbuddy2api] 授权链接（${realm}）：${authUrl}`)
    if (userQuestions?.ask === undefined) {
      throw new Error(
        `请在浏览器中打开以下链接完成 ${realm === 'global' ? '国际版' : '国内版'} 授权：\n\n  ${authUrl}\n\n`
        + '授权完成后重跑 /wb2api-login（dsh 的 user-questions 服务不可用，无法在此等待你的确认）。',
      )
    }
    const yes = '已完成授权，继续'
    const answer = await userQuestions.ask({
      questions: [{
        id: 'wb2api-auth',
        question: '请在浏览器中打开下面的链接完成授权，完成后选择第一项：',
        header: '账号授权',
        detail: `${authUrl}\n\n`
          + `（${realm === 'global' ? '国际版 workbuddy.ai' : '国内版 codebuddy.cn'} · `
          + '链接由上游签发，仅用于本次登录）',
        options: [{ label: yes, description: '上游确认后凭证会自动写入 auths/ 并重启网关' }],
      }],
      agent,
    })
    return answer.answers[0]?.selected[0] === yes
  }

  // ③ 一键就绪：二进制 → 账号 → 启网关 → 同步模型。
  ctx.commands.register({
    name: 'wb2api-setup',
    description: '一键就绪：准备网关可执行文件、登录账号、启动网关并同步模型目录',
    input: { hint: '[cn | global]（仅首次登录时需要）' },
    handler: async ({ agent, rawInput }): Promise<CommandResult> => {
      try {
        // 参数里的 realm 若非法要**立刻报错**而不是回退询问：静默忽略会让用户以为
        // 「我指定了 global」而其实登进了 cn。
        const trimmed = rawInput.trim()
        const realmArg = parseRealmArg(trimmed)
        if (trimmed !== '' && realmArg === undefined) {
          return {
            kind: 'error',
            text: `无法识别参数 «${trimmed}»。用法：/wb2api-setup [cn | global]（不带参数则沿用已有账号或弹窗询问）`,
          }
        }
        const runner = new SetupRunner({
          config,
          ...supervisor !== undefined ? { supervisor } : {},
          accountStore,
          installer,
          performLogin: async (realm) => {
            // 未指定就弹窗问；弹不出来（无 user-questions）时如实失败，不猜一个域。
            let resolved = realm
            if (resolved === undefined && (config.defaultRealm === 'cn' || config.defaultRealm === 'global')) {
              resolved = config.defaultRealm
            }
            if (resolved === undefined) {
              try {
                resolved = await chooseRealmFromMenu(agent)
              } catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) }
              }
            }
            const result = await runLogin(resolved, agent)
            if (!result.ok) return { ok: false, detail: result.text }
            const uid = accountStore.list().find(item => item.enabled)?.uid
            return { ok: true, ...uid !== undefined ? { uid } : {} }
          },
          refreshModels: () => catalog.get(true),
          logger: ctx.logger,
        })
        const outcome = await runner.run(realmArg)
        return { kind: outcome.ready ? 'success' : 'error', text: renderSetupReport(outcome) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  /**
   * 弹出账号列表让用户点选。
   *
   * 返回 `undefined` = 用户取消（UI 未回传选择）；**抛错** = 弹窗通道不可用
   * （服务缺失，或 agent 不是 live runtime root 时的 `DELEGATED_CALLER`），
   * 由调用方把错误原样呈现给用户并提示参数用法 —— 静默降级成「什么都不做」更糟。
   */
  const chooseAccountFromMenu = async (menu: {
    accounts: AuthAccount[]
    live: Record<string, unknown> | undefined
    agent: unknown
    signal: AbortSignal
  }): Promise<AccountSelection | undefined> => {
    if (userQuestions?.ask === undefined) {
      throw new Error(
        'dsh 的 user-questions 服务不可用，无法弹出选择列表。'
        + '改用参数形式：/wb2api-account auto | <序号> | <uid 前缀>',
      )
    }
    const liveByUid = indexGatewayAccounts(menu.live)
    const autoLabel = '自动 · 全部账号参与轮换'
    const labels = new Map<string, AccountSelection>([[autoLabel, { kind: 'auto' }]])
    const accountOptions = menu.accounts.map((account) => {
      const base = `${account.nickname !== '' ? account.nickname : '(无昵称)'} · ${shortUid(account.uid)}`
      // label 是答案回传的唯一键：同昵称（甚至同短 uid）撞车时必须补足区分度，
      // 否则点 A 会切到 B。
      const label = labels.has(base) ? `${base} · ${account.realm}` : base
      labels.set(label, { kind: 'single', uid: account.uid })
      return { label, description: describeAccount(account, liveByUid.get(account.uid)) }
    })
    const enabled = menu.accounts.filter(a => a.enabled)
    const answer = await userQuestions.ask({
      questions: [{
        id: 'wb2api-account',
        question: '网关使用哪个账号？',
        header: '账号',
        detail: `当前：${describeSelection(menu.accounts, enabled)}\n`
          + '选中单个账号 = 只启用它、其余改名为 .disabled，并重启网关（切换期间请求会中断约 1~3 秒）；'
          + '选「自动」= 恢复全部账号参与加权轮换。',
        options: [
          { label: autoLabel, description: '网关自行按积分/快过期积分/闲置加权轮换（默认）' },
          ...accountOptions,
        ],
      }],
      agent: menu.agent,
      signal: menu.signal,
    })
    const first = answer.answers.find(item => item.id === 'wb2api-account') ?? answer.answers[0]
    const selected = first?.selected[0]
    if (selected !== undefined) {
      const hit = labels.get(selected)
      if (hit !== undefined) return hit
    }
    // 用户在「其他」里自由输入：按同一套语法解析，避免两个入口语义不一致。
    const custom = first?.custom?.trim() ?? ''
    if (custom !== '') return parseAccountSelector(menu.accounts, custom)
    return undefined
  }

  // ③ 账号切换：重命名 auths/ 凭证文件 → 重启网关。
  //
  // 「先停 → 改名 → 再启」的顺序是硬要求，原因见 accounts.ts 模块头（网关会用内存里的旧
  // FilePath 把改过名的文件写回来，禁用静默失效）。因此这里不用 supervisor.restart()
  // ——它无法在停与启之间插入改名。
  ctx.commands.register({
    name: 'wb2api-account',
    description: '查看并切换网关使用的账号（不带参数时弹出可点选列表）',
    input: { hint: 'auto | <序号> | <uid 前缀>' },
    handler: async ({ agent, rawInput, signal }): Promise<CommandResult> => {
      try {
        if (supervisor === undefined) {
          return { kind: 'error', text: 'subprocess 服务不可用，无法托管网关进程（切换需要停/启网关）。' }
        }
        const inventory = accountStore.list()
        if (inventory.length === 0) {
          return {
            kind: 'error',
            text: `auths 目录里没有任何 workbuddy*.json 凭证文件：${accountStore.authDir()}\n`
              + '先跑 ./login.sh 完成登录（详见 /wb2api-login）。',
          }
        }

        // 复用外部网关时停不掉它 → 改名必被它的 token 刷新写回覆盖。直接拒绝，
        // 而不是做一次「看着成功、一分钟后又变回原样」的假切换。
        const before = await supervisor.statusWithHealth()
        if (before.state === 'external') {
          return {
            kind: 'error',
            text: '端口上运行的网关不由本插件托管（状态 external），改名会被它的 token 刷新重新写回，切换无法生效。\n'
              + '请先停掉那个进程，再 /wb2api-start 交给插件托管；或改用 /wb2api-login + /wb2api-restart 手工加号。\n'
              + `auths 目录：${accountStore.authDir()}`,
          }
        }

        const live = await fetchGatewayStatus(config.baseURL, await apiKeyResolver(), config.healthTimeoutSeconds * 1000)
        const selection = rawInput.trim() === ''
          ? await chooseAccountFromMenu({ accounts: inventory, live, agent, signal })
          : parseAccountSelector(inventory, rawInput)
        if (selection === undefined) {
          return { kind: 'success', text: '已取消，未做任何改动。' }
        }

        const plan = planRenames(inventory, selection)
        if (plan.length === 0) {
          return {
            kind: 'success',
            text: `已经是该状态，未改动：${describeSelection(inventory, inventory.filter(a => a.enabled))}`,
          }
        }

        await supervisor.stop()
        let applied
        try {
          applied = accountStore.applySelection(selection)
        } catch (error) {
          // 改名失败必须把网关拉回来：否则环境停在「网关已停」比切换失败更糟。
          await supervisor.start().catch(() => undefined)
          throw error
        }
        const after = await supervisor.start()
        await catalog.get(true)

        const enabled = applied.accounts.filter(a => a.enabled)
        const lines = [
          `已切换为：${describeSelection(applied.accounts, enabled)}`,
          '',
          '凭证文件改动:',
          ...applied.renamed.map(item => `  ${item.enabled ? '＋启用' : '－禁用'} ${basename(item.from)}`),
          '',
          `网关: ${after.state === 'failed'
            ? `启动失败（${after.lastError ?? '未知原因'}）`
            : after.state === 'external' ? '端口上已有外部网关（复用）' : '已重启'}`,
        ]
        if (after.health !== undefined) {
          lines.push(`账号: ${after.health.healthy}/${after.health.total} 可用`)
          if (after.health.healthy === 0) {
            lines.push('提示: 当前启用集里没有可用账号（可能正在冷却）。用 /wb2api-account auto 恢复全部账号，或 /wb2api-login 加号。')
          }
        }
        lines.push('', `模型目录已刷新；auths 目录：${accountStore.authDir()}`)
        return {
          kind: after.state === 'failed' ? 'error' : 'success',
          text: lines.join('\n'),
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ③ 生命周期：dispose 时终止全部受管进程。
  // dsh-subprocess 的 dispose 本身也会终止受管进程，这里显式停止是为了
  // 保证「先停网关、再卸服务」的顺序，并清掉待执行的重启定时器。
  ctx.effect(() => () => {
    void supervisor?.dispose()
  }, 'workbuddy2api: gateway lifecycle')

  // ④ 自动启动：延迟到 fiber 稳定后再拉起，避免插件加载阶段阻塞 dsh 启动。
  if (config.autoStart && supervisor !== undefined) {
    const timer = setTimeout(() => {
      void (async () => {
        // 缺二进制时的行为是**配置决定**的，不是默认行为：autoDownloadBinary 默认关。
        // 隐式时机的联网下载在离线/内网环境只会刷报错，而用户从未要求联网；
        // 显式跑 /wb2api-setup 时则无视该开关（那是明确意图）。
        if (config.autoDownloadBinary) {
          try {
            await supervisor.resolveBinary()
          } catch (error) {
            ctx.logger.info(`[workbuddy2api] 未找到网关可执行文件，按配置自动下载（autoDownloadBinary=true）`)
            try {
              const installed = await installer.ensure()
              ctx.logger.info(`[workbuddy2api] 网关可执行文件已就绪：${installed.path}`)
            } catch (downloadError) {
              ctx.logger.error(
                `[workbuddy2api] 自动下载失败：${downloadError instanceof Error ? downloadError.message : String(downloadError)}。`
                + '可手工执行 /wb2api-setup 重试。',
              )
              return
            }
          }
        }
        const status = await supervisor.start()
        if (status.state === 'failed') {
          ctx.logger.error(`[workbuddy2api] 自动启动失败：${status.lastError ?? '未知原因'}`)
        }
      })().catch((error: unknown) => {
        ctx.logger.error(
          `[workbuddy2api] 自动启动失败：${error instanceof Error ? error.message : String(error)}。`
          + '可用 /wb2api-setup 或 /wb2api-start 手工重试。',
        )
      })
    }, 0)
    timer.unref?.()
    ctx.effect(() => () => { clearTimeout(timer) }, 'workbuddy2api: autostart timer')
  }

  const origin = gatewayOrigin(config.baseURL)
  ctx.logger.info(
    `[workbuddy2api] provider "${PROVIDER}" 已注册（端点 ${config.baseURL}`
    + `${config.autoStart ? `，启动后自动拉起 ${origin}` : '，未启用自动启动'}）`,
  )
}
