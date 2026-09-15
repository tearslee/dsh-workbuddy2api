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
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import Schema from '@deepseek-ai/schemastery'
import { resolveConfig, gatewayOrigin, PROVIDER, SETTINGS_NS, type GatewayPluginConfig } from './config.js'
import { mapModelCatalog, ModelCatalog } from './models.js'
import { GatewayAdapter } from './gateway-adapter.js'
import { GatewaySupervisor } from './gateway-supervisor.js'

export { Config, DEFAULT_CONFIG, resolveConfig, PROVIDER, SETTINGS_NS } from './config.js'
export type { GatewayPluginConfig, RealmPrefixPolicy } from './config.js'
export { GatewayAdapter } from './gateway-adapter.js'
export { GatewaySupervisor } from './gateway-supervisor.js'
export { ModelCatalog, mapModelCatalog, mapModel, parseModelId, toWireModel } from './models.js'

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

/** 从网关 `config.json` 读取 `api_key`（同机部署时无需重复配置凭据）。 */
function readApiKeyFromGatewayConfig(config: GatewayPluginConfig): string | undefined {
  const candidates: string[] = []
  if (config.repoPath.length > 0) candidates.push(join(config.repoPath, 'config.json'))
  if (config.workingDir.length > 0) candidates.push(join(config.workingDir, 'config.json'))
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
    description: '显示 workbuddy2api 网关状态、账号可用性与模型数量',
    handler: async (): Promise<CommandResult> => {
      try {
        if (supervisor === undefined) {
          return { kind: 'error', text: 'subprocess 服务不可用，无法托管网关进程。' }
        }
        const status = await supervisor.statusWithHealth()
        const models = await catalog.get()
        const authFiles = supervisor.countAuthFiles()
        const modelLine = models.length > 0
          ? `\n模型目录: ${models.length} 个（示例: ${models.slice(0, 5).map(model => model.id).join(', ')}${models.length > 5 ? ', …' : ''}）`
          : `\n模型目录: 拉取失败${catalog.lastError !== undefined ? `（${catalog.lastError}）` : ''}`
        // 路由被占用的状态必须显式暴露：此时插件托管了网关，但模型请求走的是
        // settings.yaml 里那份手工配置 —— 不说清楚会让人以为插件没生效。
        const routeLine = routeOwnedByOther
          ? `\n\n⚠ provider 路由 "${PROVIDER}" 未由本插件注册（已被 settings.yaml 占用）。`
            + '\n请删除 ~/.dsh/settings.yaml 里的 llm-pi-ai.providers.workbuddy2api 段后重启 dsh。'
          : ''
        return { kind: 'success', text: renderStatus(status, authFiles) + modelLine + routeLine }
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
    description: '显示 workbuddy2api 账号登录指引（登录为交互式 OAuth，需在终端执行）',
    handler: async (): Promise<CommandResult> => {
      const repoPath = config.repoPath
      const loginScript = repoPath.length > 0 ? join(repoPath, 'login.sh') : ''
      const lines = [
        'workbuddy2api 的账号登录是**交互式 OAuth**，必须在真实终端里执行 —— dsh 命令处理器没有 TTY，',
        '无法代替你完成浏览器授权。',
        '',
        '步骤：',
      ]
      if (repoPath.length > 0) {
        lines.push(`  1. 打开终端并进入网关目录：cd "${repoPath}"`)
        lines.push('  2. 运行登录脚本：./login.sh')
      } else {
        lines.push('  1. 打开终端并进入 workbuddy2api 源码目录（插件配置 repoPath 未设置）')
        lines.push('  2. 运行登录脚本：./login.sh')
      }
      lines.push('  3. 按提示在浏览器完成授权，凭证会写入 auths/*.json')
      lines.push('  4. 回到 dsh 执行 /wb2api-restart 让网关重新加载账号')
      lines.push('  5. 执行 /wb2api-status 确认 healthy 数量大于 0')
      if (loginScript.length > 0) {
        lines.push('', `登录脚本位置: ${loginScript}${existsSync(loginScript) ? '' : '（未找到，请确认 repoPath）'}`)
      }
      const authFiles = supervisor?.countAuthFiles() ?? 0
      lines.push(`当前 auths/ 凭证文件: ${authFiles} 个`)
      return { kind: 'success', text: lines.join('\n') }
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
      void supervisor.start()
        .then((status) => {
          if (status.state === 'failed') {
            ctx.logger.error(`[workbuddy2api] 自动启动失败：${status.lastError ?? '未知原因'}`)
          }
        })
        .catch((error: unknown) => {
          ctx.logger.error(
            `[workbuddy2api] 自动启动失败：${error instanceof Error ? error.message : String(error)}。`
            + '可用 /wb2api-start 手工重试。',
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
