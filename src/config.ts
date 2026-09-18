/**
 * 插件配置 schema。
 *
 * 配置来源有两层：
 *  1. **组合层（composition）** —— `cordis.patch.yml` 里插件行的字段，
 *     由 cordis 按本文件的 {@link Config} schema 解析后作为 `apply(ctx, config)` 的入参；
 *  2. **默认值** —— 本文件的 {@link DEFAULT_CONFIG}。
 *
 * 注意：本插件**不使用** settings 文件里的用户层配置（网关自身的 config.json
 * 才是权威）。这里注册的 settings namespace 只为让模型设置页有合法的
 * `settingsNs` 地址，避免 `deriveKeyRef(provider)` 崩溃，见 `index.ts`。
 *
 * @module dsh-workbuddy2api/config
 */

import Schema from '@deepseek-ai/schemastery'

/**
 * schemastery schema 的**可移植**类型别名。
 *
 * 显式标注 {@link Config} 的类型是必需的：schemastery 的 `Schema<S, T>` 泛型间接引用了
 * `@deepseek-ai/cosmokit` 的 `Dict`，若让 tsc 自行推断 `Config` 的类型，在 pnpm 的隔离
 * 布局下会报
 * `TS2742: The inferred type of 'Config' cannot be named without a reference to
 * '.pnpm/@deepseek-ai+cosmokit@...'` —— 生成的 `.d.ts` 引用了不可移植的路径。
 *
 * 消费侧（`settings.register` / cordis 配置解析）只要求「有 `toJSON()` 的 schemastery
 * schema」，因此这里只声明实际被用到的结构，避免把 cosmokit 类型泄进声明文件。
 */
interface AnySchema {
  (value: unknown): unknown
  toJSON(): unknown
}

/** provider 路由 id。**永久不可改** —— 会话历史、请求日志、凭据引用都以它为主键。 */
export const PROVIDER = 'workbuddy2api'

/** 插件自身的 settings namespace（同时也是 provider 的 settingsNs）。 */
export const SETTINGS_NS = 'llm-workbuddy2api'

/**
 * 模型 id 的 realm 前缀策略。
 *
 * 网关 `/v1/models` 返回的 id 带 `cn:` / `global:` 前缀（`internal/server/handler.go`
 * 的 `modelList()`），而 `resolveModel`（`internal/server/resolve_model.go`）对
 * **无前缀**模型名一律判为 `cn` 域。
 * 因此两种策略在现有单域（仅 CN 账号）环境下行为**完全一致**：
 *
 * - `strip-cn`（默认）—— 剥掉 `cn:` 前缀，`global:` 前缀保留。
 *   模型下拉里的 id 与管理员手工配置时期完全一致，历史会话/预设无需迁移。
 * - `keep` —— 原样透出 `cn:x` / `global:x`。
 *   双域账号并存时每个模型会各出现一份，但能显式路由到 global 账号。
 *
 * **线格式（wire）与展示（display）是两件事**：无论哪种策略，`stream()` 发出请求前
 * 都会把无前缀 id 补成 `cn:<id>`。这样即使迁到 `keep` 策略、或用户手输裸名，
 * 都不会因 realm 解析歧义而路由到错误域名。
 */
export type RealmPrefixPolicy = 'strip-cn' | 'keep'

/** 插件组合层配置（`cordis.patch.yml` 中插件行的字段）。 */
export interface GatewayPluginConfig {
  /** 网关 OpenAI 兼容端点根，默认 `http://127.0.0.1:7863/v1`。 */
  baseURL: string
  /** 从 dsh 凭据库读取网关 api_key 的 ref 名；为空则读同名环境变量。 */
  apiKeyRef: string
  /** 显式指定网关可执行文件绝对路径；为空则按 repoPath / 缓存目录 / PATH 依次探测。 */
  binaryPath: string
  /** 网关源码仓库根目录（用于定位二进制、作为默认 cwd、逻辑上支撑按需 go build）。 */
  repoPath: string
  /** 网关子进程工作目录；为空时取 repoPath，其次取 binaryPath 所在目录。 */
  workingDir: string
  /** 网关监听端口，默认 7863。仅用于「端口已占用」判定与状态展示。 */
  listenPort: number
  /** dsh 启动时是否自动拉起网关。关闭后仍可用 `/wb2api-start` 手工拉起。 */
  autoStart: boolean
  /** 模型 id 的 realm 前缀策略，见 {@link RealmPrefixPolicy}。 */
  realmPrefixPolicy: RealmPrefixPolicy
  /** `/v1/models` 元数据缓存 TTL（秒）。 */
  modelsTtlSeconds: number
  /** 单次请求整体超时（秒）。 */
  requestTimeoutSeconds: number
  /** SSE 帧间空闲超时（秒）。超过则报可重试的 TIMEOUT。 */
  idleTimeoutSeconds: number
  /** 首个 token 等待超时（秒）。 */
  firstTokenTimeoutSeconds: number
  /** 探活超时（秒）。 */
  healthTimeoutSeconds: number
  /** 子进程优雅退出宽限期（毫秒），传给 subprocess 的 graceMs。 */
  graceMs: number
  /** 进程被终止后的自动重启次数上限；超过后停止重启并暴露状态。 */
  crashRestartLimit: number
  /** 传给网关子进程的显式环境变量。 */
  env: Record<string, string>
  /**
   * 预编译二进制的发布仓库（`owner/name`）。
   *
   * 默认是本插件仓库 —— 它的 Actions 从**上游源码**交叉编译三平台产物并挂 Release。
   * 上游自身不提供任何预编译产物，所以这里指向的不是上游。
   */
  binaryReleaseRepo: string
  /**
   * 覆盖二进制下载根地址（自建镜像 / 内网分发 / 钉住某个 tag）。
   *
   * 为空时用 `https://github.com/<binaryReleaseRepo>/releases/latest/download`；
   * 需要钉版本就写成 `.../releases/download/v0.3.0`。该地址下应同时存在
   * `<产物名>.zip` 与 `SHA256SUMS.txt`。
   */
  binaryReleaseBase: string
  /**
   * dsh 启动时若找不到二进制，是否自动下载。
   *
   * **默认 false**：下载发生在首次启动这种隐式时机时，离线/内网环境只会看到一堆
   * 报错噪音，而用户并没有要求联网。显式执行 `/wb2api-setup` 时**无视本开关**
   * （那是用户的明确意图）。
   */
  autoDownloadBinary: boolean
  /** 登录默认使用的 realm；为空则在 `/wb2api-setup` 里询问（或要求显式传参）。 */
  defaultRealm: string
}

export const DEFAULT_CONFIG: GatewayPluginConfig = {
  baseURL: 'http://127.0.0.1:7863/v1',
  apiKeyRef: 'WORKBUDDY2API_API_KEY',
  binaryPath: '',
  repoPath: '',
  workingDir: '',
  listenPort: 7863,
  autoStart: true,
  realmPrefixPolicy: 'strip-cn',
  modelsTtlSeconds: 600,
  requestTimeoutSeconds: 600,
  idleTimeoutSeconds: 300,
  firstTokenTimeoutSeconds: 120,
  healthTimeoutSeconds: 3,
  graceMs: 5000,
  crashRestartLimit: 3,
  env: {},
  binaryReleaseRepo: 'tearslee/dsh-workbuddy2api',
  binaryReleaseBase: '',
  autoDownloadBinary: false,
  defaultRealm: '',
}

/**
 * schemastery 配置 schema。
 *
 * **必须**用 `Schema.object({...})` 构造 —— `settings.describe()` 会对每个注册项
 * 无条件调用 `schema.toJSON()`，传裸函数会抛
 * `TypeError: registration.schema.toJSON is not a function`，
 * 连带让模型设置页、主题、sidebar 的 settings API 全部失效。
 */
export const Config: AnySchema = Schema.object({
  baseURL: Schema.string().default(DEFAULT_CONFIG.baseURL),
  apiKeyRef: Schema.string().default(DEFAULT_CONFIG.apiKeyRef),
  binaryPath: Schema.string().default(DEFAULT_CONFIG.binaryPath),
  repoPath: Schema.string().default(DEFAULT_CONFIG.repoPath),
  workingDir: Schema.string().default(DEFAULT_CONFIG.workingDir),
  listenPort: Schema.natural().default(DEFAULT_CONFIG.listenPort),
  autoStart: Schema.boolean().default(DEFAULT_CONFIG.autoStart),
  realmPrefixPolicy: Schema.union([
    Schema.const('strip-cn' as const),
    Schema.const('keep' as const),
  ]).default(DEFAULT_CONFIG.realmPrefixPolicy),
  modelsTtlSeconds: Schema.natural().default(DEFAULT_CONFIG.modelsTtlSeconds),
  requestTimeoutSeconds: Schema.natural().default(DEFAULT_CONFIG.requestTimeoutSeconds),
  idleTimeoutSeconds: Schema.natural().default(DEFAULT_CONFIG.idleTimeoutSeconds),
  firstTokenTimeoutSeconds: Schema.natural().default(DEFAULT_CONFIG.firstTokenTimeoutSeconds),
  healthTimeoutSeconds: Schema.natural().default(DEFAULT_CONFIG.healthTimeoutSeconds),
  graceMs: Schema.natural().default(DEFAULT_CONFIG.graceMs),
  crashRestartLimit: Schema.natural().default(DEFAULT_CONFIG.crashRestartLimit),
  env: Schema.dict(Schema.string()).default({}),
  binaryReleaseRepo: Schema.string().default(DEFAULT_CONFIG.binaryReleaseRepo),
  binaryReleaseBase: Schema.string().default(DEFAULT_CONFIG.binaryReleaseBase),
  autoDownloadBinary: Schema.boolean().default(DEFAULT_CONFIG.autoDownloadBinary),
  defaultRealm: Schema.string().default(DEFAULT_CONFIG.defaultRealm),
}) as unknown as AnySchema

/**
 * 把组合层传入的原始配置合并到默认值之上。
 *
 * `apply(ctx, config)` 在插件行未声明任何字段时可能收到 `undefined` 或 `{}`，
 * 因此这里做一次显式归一化，避免下游到处判空。
 *
 * @param raw - cordis 传入的已解析配置（可能不完整）。
 * @returns 字段齐全的配置对象。
 */
export function resolveConfig(raw: Partial<GatewayPluginConfig> | undefined): GatewayPluginConfig {
  const merged: GatewayPluginConfig = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  // env 是字典型字段：默认值必须与用户值合并，而不是被整体覆盖成 undefined。
  merged.env = { ...DEFAULT_CONFIG.env, ...(raw?.env ?? {}) }
  if (merged.realmPrefixPolicy !== 'keep') merged.realmPrefixPolicy = 'strip-cn'
  if (!Number.isFinite(merged.listenPort) || merged.listenPort <= 0) merged.listenPort = DEFAULT_CONFIG.listenPort
  // defaultRealm 只认两个合法值；其余（含默认空串）归一为「未指定」，由命令层询问用户。
  if (merged.defaultRealm !== 'cn' && merged.defaultRealm !== 'global') merged.defaultRealm = ''
  return merged
}

/** 由 baseURL 推导同源的根地址（剥掉结尾的 `/v1`），用于打 `/healthz`。 */
export function gatewayOrigin(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed
}

/** 由 baseURL 推导端口；解析失败时回退配置里的 listenPort。 */
export function gatewayPort(baseURL: string, fallback: number): number {
  try {
    const url = new URL(baseURL)
    if (url.port !== '') return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return fallback
  }
}
