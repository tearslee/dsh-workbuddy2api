/**
 * 网关 `/v1/models` 元数据拉取、映射与缓存。
 *
 * 这是本插件的核心价值：把网关**非标准**的扩展字段翻译成 dsh 的
 * `LlmModelInfo` / `LlmResolvedModelInfo`。内置的 openai-completions 栈不认
 * `context_length` / `supports_images` / `reasoning_supported_efforts`，
 * 这正是过去必须在 `settings.yaml` 手写 20 条元数据的根因。
 *
 * 字段来源（`workbuddy2api/internal/server/handler.go:229-302`）：
 *
 * | 网关字段 | 含义 | 备注 |
 * |---|---|---|
 * | `id` | 模型 id，带 `cn:` / `global:` realm 前缀 | `handler.go:234` |
 * | `context_length` | 上下文窗口（0 时网关兜底 131072） | `handler.go:238,241-243` |
 * | `max_output_tokens` | 输出上限 | `handler.go:239` |
 * | `supports_images` | 多模态（**仅在支持时出现**） | `handler.go:244-246` |
 * | `reasoning_supported_efforts` | 可选思考档位（空则不出现） | `handler.go:249-250` |
 * | `reasoning_default_effort` | 默认档位 | `handler.go:251-253` |
 *
 * **已知上游局限（不要在插件侧掩盖）**：`global:` 分支（`handler.go:284-299`）
 * 把 `context_length` 硬编码为 131072，且**不下发** `max_output_tokens` 与
 * `supports_images`。因此 global 模型的窗口/输出上限是占位值而非真实值。
 *
 * @module dsh-workbuddy2api/models
 */

/** 网关 `context_length` 缺失时的兜底值，与网关自身兜底保持一致（`handler.go:242`）。 */
export const CONTEXT_WINDOW_FALLBACK = 131072

/** 归一化后的单个模型元数据。 */
export interface GatewayModel {
  /** 去 realm 前缀后的裸模型 id（出站/选号/账本使用的名字）。 */
  bareId: string
  /** realm，`'cn'` 或 `'global'`。 */
  realm: 'cn' | 'global'
  /**
   * 暴露给 dsh 的模型 id。由 `realmPrefixPolicy` 决定是裸名还是带前缀名。
   * 请求发出前会被 {@link toWireModel} 还原成网关认得的形态。
   */
  id: string
  /** 展示名。双域并存时在描述里标注 realm，避免同名模型无法区分。 */
  name: string
  /** 上下文窗口，保证为正数。 */
  contextWindow: number
  /** 输出上限；网关未下发时缺席。 */
  maxOutputTokens?: number
  /** 是否支持图片输入；网关仅在支持时下发该字段。 */
  supportsImages: boolean
  /** 可选思考档位；网关未下发或为空数组时为空数组。 */
  efforts: readonly string[]
  /** 默认思考档位；**保证包含于 {@link efforts}**，否则为 undefined。 */
  defaultEffort?: string
}

/** `/v1/models` 原始条目（只声明我们消费的字段，其余忽略）。 */
interface RawModelEntry {
  id?: unknown
  context_length?: unknown
  max_output_tokens?: unknown
  supports_images?: unknown
  reasoning_supported_efforts?: unknown
  reasoning_default_effort?: unknown
}

/**
 * 拆解网关模型 id 的 realm 前缀。
 *
 * 与网关 `resolveModel`（`resolve_model.go:13-23`）语义严格对称：
 * 取第一个 `:`，前段**恰为** `cn` / `global` 才视为前缀（大小写敏感）；
 * 否则整串视为裸名，realm 落到 `cn`。
 *
 * @param rawId - 网关返回的原始 id。
 * @returns realm 与裸模型名。
 */
export function parseModelId(rawId: string): { realm: 'cn' | 'global'; bareId: string } {
  const idx = rawId.indexOf(':')
  if (idx < 0) return { realm: 'cn', bareId: rawId }
  const prefix = rawId.slice(0, idx)
  if (prefix !== 'cn' && prefix !== 'global') return { realm: 'cn', bareId: rawId }
  return { realm: prefix, bareId: rawId.slice(idx + 1) }
}

/**
 * 把 dsh 侧的模型 id 还原成网关认得的线格式。
 *
 * 无前缀 id 一律补 `cn:`：网关对裸名的判定虽然也是 `cn`，但**显式前缀**能让
 * 选号闭包正确过滤 realm 集合（`handler.go:430-434` 说明裸名会在跨域粘性会话里
 * 被错误钉回 CN 集合）。补前缀不改变单域环境下的行为，却能消除歧义。
 *
 * @param model - dsh 传入的模型 id（可能带也可能不带 realm 前缀）。
 * @returns 可直接放进请求体的网关模型名。
 */
export function toWireModel(model: string): string {
  const { realm, bareId } = parseModelId(model)
  return `${realm}:${bareId}`
}

/** 提取字符串数组；非数组或元素非字符串时按空数组处理。 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** 提取正有限数；其余（含 0、负数、非数）返回 undefined。 */
function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

/**
 * 把一条 `/v1/models` 原始条目映射为 {@link GatewayModel}。
 *
 * 映射规则（对照 `LlmResolvedModelInfo` 的字段语义）：
 * - `context_length` → `context.contextWindow`；缺失/非正数时用
 *   {@link CONTEXT_WINDOW_FALLBACK} 兜底（与网关 `handler.go:242` 一致）。
 * - `max_output_tokens` → `defaultMaxTokens`；缺失时**不声明**，让网关自己决定。
 * - `supports_images` **仅在支持时出现**，故缺席即「仅文本」，映射为
 *   `inputModalities: ['text']`（显式否定能力，而非 unknown）。
 * - `reasoning_supported_efforts` → `reasoning.efforts`；空则不声明整个 `reasoning`。
 * - `reasoning_default_effort` → `reasoning.defaultEffort`，**必须先校验它包含于
 *   efforts 之内**，否则 dsh 会拿着一个模型并不支持的档位去发请求。
 *
 * @param raw - `/v1/models` 的一个条目。
 * @param policy - realm 前缀策略。
 * @returns 归一化后的模型；id 非法时返回 undefined。
 */
export function mapModel(raw: RawModelEntry, policy: 'strip-cn' | 'keep'): GatewayModel | undefined {
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  const { realm, bareId } = parseModelId(raw.id)
  if (bareId.length === 0) return undefined

  const efforts = toStringArray(raw.reasoning_supported_efforts)
  // 默认档必须是 efforts 的子集：网关下发的默认档偶尔会落在支持集之外，
  // 直接透出会让 dsh 用非法档位发请求（照 buddy-adapter.ts:486-488 的写法）。
  const rawDefault = typeof raw.reasoning_default_effort === 'string' ? raw.reasoning_default_effort : undefined
  const defaultEffort = rawDefault !== undefined && efforts.includes(rawDefault) ? rawDefault : undefined

  // strip-cn 策略：只剥 cn:，global: 必须保留（否则国际版账号路由不到）。
  const id = policy === 'strip-cn' && realm === 'cn' ? bareId : `${realm}:${bareId}`

  return {
    bareId,
    realm,
    id,
    name: bareId,
    contextWindow: toPositiveNumber(raw.context_length) ?? CONTEXT_WINDOW_FALLBACK,
    ...toPositiveNumber(raw.max_output_tokens) !== undefined
      ? { maxOutputTokens: toPositiveNumber(raw.max_output_tokens) }
      : {},
    supportsImages: raw.supports_images === true,
    efforts,
    ...defaultEffort !== undefined ? { defaultEffort } : {},
  }
}

/**
 * 把整个 `/v1/models` 响应体映射为模型目录。
 *
 * 关于重名：**两种策略下 CN 与 global 都不会撞 id**。`keep` 下两侧都带前缀；
 * `strip-cn` 下 CN 剥成裸名、global 仍带 `global:` 前缀。因此 realm 重名不是问题，
 * 这里的去重只处理**同一 id 重复出现**的情形（网关名单是「探测结果 ∪ 静态 overlay」
 * 合并而来，理论上可能重复）。
 *
 * 重复时保留**信息更完整**的那条：优先保留带 `max_output_tokens` 的条目。这与
 * `strip-cn` 的域语义一致 —— CN 侧有真实窗口/输出上限，global 侧是占位值。
 *
 * @param body - `GET /v1/models` 的已解析 JSON。
 * @param policy - realm 前缀策略。
 * @returns 去重后的模型目录，保持网关返回顺序。
 */
export function mapModelCatalog(body: unknown, policy: 'strip-cn' | 'keep'): GatewayModel[] {
  const data = (body as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(data)) return []
  const byId = new Map<string, GatewayModel>()
  for (const entry of data as RawModelEntry[]) {
    const model = mapModel(entry, policy)
    if (model === undefined) continue
    const existing = byId.get(model.id)
    if (existing === undefined || (existing.maxOutputTokens === undefined && model.maxOutputTokens !== undefined)) {
      byId.set(model.id, model)
    }
  }
  return [...byId.values()]
}

/** 模型目录缓存，带 TTL 与并发去重（同一时刻只发一次上游请求）。 */
export class ModelCatalog {
  private models: GatewayModel[] | undefined
  private fetchedAt = 0
  private inFlight: Promise<GatewayModel[]> | undefined

  /** 上一次拉取的失败原因；成功后被清空。用于状态命令暴露真实病因。 */
  lastError: string | undefined

  constructor(private readonly options: {
    /** 拉取函数；抛错表示上游不可用。 */
    fetchCatalog: () => Promise<GatewayModel[]>
    /** 缓存 TTL（毫秒）。 */
    ttlMs: number
    /** 注入时钟，便于测试。 */
    now?: () => number
  }) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * 取模型目录（命中缓存则直接返回）。
   *
   * @param force - 忽略 TTL 强制刷新。
   * @returns 模型目录；上游失败时若有旧缓存则回退旧缓存，否则返回空数组。
   */
  async get(force = false): Promise<GatewayModel[]> {
    const fresh = this.models !== undefined && this.now() - this.fetchedAt < this.options.ttlMs
    if (!force && fresh) return this.models as GatewayModel[]
    if (this.inFlight !== undefined) return this.inFlight
    this.inFlight = this.refresh()
    try {
      return await this.inFlight
    } finally {
      this.inFlight = undefined
    }
  }

  private async refresh(): Promise<GatewayModel[]> {
    try {
      const models = await this.options.fetchCatalog()
      this.models = models
      this.fetchedAt = this.now()
      this.lastError = undefined
      return models
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      // 上游暂不可用：保留旧目录，避免模型下拉突然变空。
      return this.models ?? []
    }
  }

  /** 按暴露给 dsh 的 id 精确查找。 */
  async find(id: string): Promise<GatewayModel | undefined> {
    const models = await this.get()
    return models.find((model) => model.id === id)
  }
}
