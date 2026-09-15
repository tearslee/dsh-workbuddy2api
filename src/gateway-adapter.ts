/**
 * `LlmAdapter` 实现：把 dsh 的 `GenerateOptions` 组装成 OpenAI chat-completions
 * 请求，发往本地 workbuddy2api 网关，再把 SSE 流翻译回 `StreamChunk`。
 *
 * **本适配器刻意很薄**。协议适配、账号池、熔断、定时任务、SSE 重建、payload 改写
 * 全部留在 Go 侧（`internal/upstream/*`、`internal/pool/*`），这里只做三件事：
 *   1. harness 消息 → OpenAI 线格式；
 *   2. 发流 + 空闲超时；
 *   3. OpenAI SSE → dsh `StreamChunk`。
 *
 * 因为没有 OAuth / 签名 / token 续期 / 多账号，这里不需要 codearts 那套
 * `resolveCredential` / `refresh` / `AccountPool` 机制 —— api_key 固定，直接读凭据即可。
 *
 * @module dsh-workbuddy2api/gateway-adapter
 */

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveToolPairing, type SsePhase } from './sse.js'
import { CONTEXT_WINDOW_FALLBACK, toWireModel, type GatewayModel, type ModelCatalog } from './models.js'

/** 从 harness 内容块里取出纯文本。 */
export function contentToText(content: unknown): string {
  // 字符串直通：历史里存在 content 为纯字符串的条目，漏掉这一行会让整条消息变空串。
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map((block) => String(block.text))
    .join('')
}

/** 收集内容块里的图片引用附件对象。 */
export function collectImageRefs(content: unknown, into: unknown[]): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image') {
      const attachment = (block as { attachment?: unknown }).attachment
      if (attachment !== undefined && attachment !== null) into.push(attachment)
    }
  }
}

/** 一个图片引用对应的线格式 part。 */
interface ImagePart { type: 'image_url'; image_url: { url: string } }

/**
 * 把 harness 消息序列化为 OpenAI chat-completions 线格式。
 *
 * 三条规则（照 codearts 两个适配器的既有实现，缺一不可）：
 *  1. user 消息里搭载的 `tool-result` 块必须**展开为独立的 `{role:'tool'}` 消息**；
 *  2. 孤儿 tool_calls / tool 结果按 {@link resolveToolPairing} 的 keep 集合过滤；
 *  3. 纯工具结果的 user 消息**不产生** user 条目（否则会多出一条空消息）。
 *
 * @param messages - harness 会话消息。
 * @param imageUrls - 图片引用对象 → data URL；缺失或未命中时图片降级为忽略。
 * @returns OpenAI 线格式消息数组。
 */
export function serializeMessages(
  messages: readonly { role: string; content: unknown }[],
  imageUrls?: ReadonlyMap<unknown, string>,
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  const { keepCallIds, keepResultIds } = resolveToolPairing(messages)

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const toolCallBlocks = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter(block => keepCallIds.has(String(block.id)))
      const toolCalls = toolCallBlocks.map((block) => ({
        id: String(block.id),
        type: 'function' as const,
        function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) },
      }))
      const reasoning = content
        .filter((block): block is { type: string; text: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'reasoning')
        .map((block) => String(block.text))
        .join('')
      const text = contentToText(content)
      wire.push({
        role: 'assistant',
        // 正文为空且带工具调用时 content 必须为 null（OpenAI 规范）。
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }

    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }

    // user 角色：工具结果搭载在 harness 用户消息中，展开为独立的 role:'tool' 消息。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    const text = contentToText(message.content)

    // 含图片时 content 升级为 OpenAI 多模态 parts。
    const parts: ImagePart[] = []
    if (imageUrls !== undefined && imageUrls.size > 0) {
      const refs: unknown[] = []
      collectImageRefs(content, refs)
      for (const ref of refs) {
        const url = imageUrls.get(ref)
        // 读取失败时丢该图片（模型仍能看到正文），而不是发一个空 URL 让网关 400。
        if (url !== undefined && url.length > 0) parts.push({ type: 'image_url', image_url: { url } })
      }
    }

    if (parts.length > 0) {
      wire.push({
        role: 'user',
        content: [...text.length > 0 ? [{ type: 'text', text }] : [], ...parts],
      })
    } else if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }

    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 assistant tool_call 时后端同样会 400。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/** 安全读取 Error.message。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/** 从错误响应体里提取可读 detail。 */
export function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const error = data.error
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message.length > 0) return message
    }
    const message = data.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch {
    // 非 JSON 体：截断后原样返回。
  }
  return body.slice(0, 400)
}

/**
 * HTTP 状态码 → harness 稳定错误码。
 *
 * 429/5xx 归为可重试；401/403 是凭据问题；其余 4xx 是请求本身的问题，重试无益。
 */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status >= 500) return 'PROVIDER_ERROR'
  if (status === 400) return 'INVALID_REQUEST'
  return 'PROVIDER_ERROR'
}

/** 网络层失败（DNS / 连接被拒 / 中断）判定，归类为可重试。 */
export function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return false
  const code = (error as { cause?: { code?: unknown } }).cause?.code
  if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) {
    return true
  }
  return error instanceof TypeError
}

/** 网关 `/v1/models` 的原始 OpenAI 风格 usage。 */
interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
  prompt_cache_hit_tokens?: number
}

/** 网关 SSE 的单个 delta。 */
interface RawDelta {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

/** 网关 SSE 的单条 chunk。 */
interface RawChunk {
  choices?: Array<{ delta?: RawDelta; finish_reason?: string | null }>
  usage?: RawUsage | null
}

/** SSE 消费过程中的可变累积状态。 */
interface StreamState {
  buffer: string
  streamEnded: boolean
  finishReason?: 'stop' | 'tool_calls' | 'length'
  nextIndex: number
  text?: { index: number; kind: 'text'; text: string }
  reasoning?: { index: number; kind: 'reasoning'; text: string }
  toolIds: Map<number, string>
  toolCalls: Map<number, { index: number; text: string; callId: string; name?: string }>
  toolOrder: number[]
}

/** 适配器依赖。 */
export interface GatewayAdapterOptions {
  /** provider 路由 id（**永久不可改**，历史/日志/凭据以它为主键）。 */
  providerId: string
  /** API 端点根，如 `http://127.0.0.1:7863/v1`。 */
  baseURL: string
  /** 解析网关 api_key；返回 undefined 表示未配置。 */
  resolveApiKey: () => Promise<string | undefined>
  /** 模型目录（含 TTL 缓存）。 */
  catalog: ModelCatalog
  /** 注入 fetch，便于测试。 */
  fetchImpl?: typeof fetch
  /** 单次请求整体超时（毫秒）。 */
  requestTimeoutMs: number
  /** SSE 帧间空闲超时（毫秒）。 */
  idleTimeoutMs: number
  /** 首 token 等待超时（毫秒）。 */
  firstTokenTimeoutMs: number
  /**
   * 可选：把图片附件读成原始字节。缺失时图片不内联，
   * 请求退化为纯文本（`inputModalities` 仍如实声明模型能力）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
}

/** workbuddy2api 网关的 LLM 适配器。 */
export class GatewayAdapter extends LlmAdapter {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: GatewayAdapterOptions) {
    super()
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * dsh 会强制校验 `info.id === provider` 且 `info.name` 非空；模型设置页还会用该 id
   * 计算 `deriveKeyRef(provider)`（内部调用 `provider.toUpperCase()`）。因此这里对入参
   * 做防御性归一化，避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.options.providerId
    return { id, name: 'WorkBuddy (workbuddy2api 网关)' }
  }

  /**
   * 模型目录：直接来自网关 `/v1/models`。
   *
   * 这是插件相对「手写 settings.yaml」的核心收益 —— 上游增删模型、调整窗口或档位时
   * 这里自动跟随，不需要改任何配置文件。
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.options.catalog.get()
    return models.map(model => this.toModelInfo(model))
  }

  /**
   * 解析单个模型的完整元数据。
   *
   * 契约要求「不校验请求路由」：即使模型不在目录里也必须返回 identity，
   * 所以未命中时回退到裸 id + 兜底窗口，而不是抛错。
   */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const found = await this.options.catalog.find(model)
    if (found === undefined) {
      return { provider, id: model, name: model, context: { contextWindow: CONTEXT_WINDOW_FALLBACK } }
    }
    const resolved: LlmResolvedModelInfo = {
      ...this.toModelInfo(found),
      context: { contextWindow: found.contextWindow },
    }
    if (found.maxOutputTokens !== undefined) resolved.defaultMaxTokens = found.maxOutputTokens
    // 思考档位：这是「思考强度」选择器出现在模型选择里的唯一入口 ——
    // composer 读取 resolveModel().reasoning。无档位可选的模型不声明该字段。
    if (found.efforts.length > 0) {
      resolved.reasoning = {
        efforts: found.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
        // defaultEffort 已在 mapModel 阶段校验过包含关系。
        ...found.defaultEffort !== undefined ? { defaultEffort: ReasoningEffortId(found.defaultEffort) } : {},
      }
    }
    return resolved
  }

  /**
   * 把模型解析与分发绑定到同一个适配器实例。
   *
   * 旧版 dsh-llm 的 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而基类尚未提供该方法时会在每轮请求开始
   * 抛 `registration.adapter.prepareCall is not a function`。当前 0.1.6-alpha.1 内嵌的
   * dsh-llm 0.1.2-rc.1 基类已自带等价实现，此处保留是为了兼容更旧的组合。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** 把归一化模型元数据投影成 dsh 的 `LlmModelInfo`。 */
  private toModelInfo(model: GatewayModel): LlmModelInfo {
    return {
      provider: this.options.providerId,
      id: model.id,
      name: model.name,
      // 双域并存时同名模型需要区分，否则模型下拉里两行完全一样。
      ...model.realm === 'global' ? { description: 'global realm（国际版账号）' } : {},
      // supports_images 仅在支持时下发，缺席即「仅文本」—— 显式否定能力而非 unknown。
      inputModalities: model.supportsImages ? (['text', 'image'] as const) : (['text'] as const),
    }
  }

  /**
   * 组装 OpenAI chat-completions 请求体。
   *
   * @param options - harness 请求。
   * @param wireMessages - 已序列化的线格式消息。
   * @param efforts - 该模型声明的思考档位白名单。
   * @returns 请求体。
   */
  buildRequestBody(
    options: GenerateOptions,
    wireMessages: Array<Record<string, unknown>>,
    efforts: readonly string[],
  ): Record<string, unknown> {
    const messages = [...wireMessages]
    // system 是 messages 数组的第一条，不是独立字段（后端只认 messages 里的 system 角色）。
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    const body: Record<string, unknown> = {
      model: toWireModel(options.model),
      messages,
      stream: true,
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop
    // tools 为空时不发该字段（不是发空数组）。
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
    }
    // 只在模型确实声明了该档位时才发 reasoning_effort：网关侧虽有降级逻辑，
    // 但不应依赖它兜底一个客户端本就知道非法的档位。
    if (options.reasoningEffort !== undefined && efforts.includes(String(options.reasoningEffort))) {
      body.reasoning_effort = String(options.reasoningEffort)
    }
    return body
  }

  /** 解析 api_key，未配置时抛出明确错误（凭据问题重试只会重复失败）。 */
  private async requireApiKey(): Promise<string> {
    const apiKey = await this.options.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new LlmError(
        'workbuddy2api: 未找到网关 api_key。请把它写入 dsh 凭据库（ref 名见插件配置 apiKeyRef），'
        + '或确认网关 config.json 的 api_key。',
        'MISSING_CREDENTIAL',
      )
    }
    return apiKey
  }

  /** 按需把图片附件读成 data URL；无图片或读不到时返回空 Map。 */
  async resolveImages(options: GenerateOptions): Promise<ReadonlyMap<unknown, string>> {
    const urls = new Map<unknown, string>()
    if (this.options.readImage === undefined) return urls
    const refs: unknown[] = []
    for (const message of options.messages) collectImageRefs(message.content, refs)
    for (const ref of refs) {
      if (urls.has(ref)) continue
      try {
        const stored = await this.options.readImage(ref)
        if (stored === undefined) continue
        urls.set(ref, `data:${stored.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`)
      } catch {
        // 读取失败：图片被跳过，正文照常发出。
      }
    }
    return urls
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = await this.requireApiKey()
    const imageUrls = await this.resolveImages(options)
    const wireMessages = serializeMessages(options.messages, imageUrls)
    const found = await this.options.catalog.find(options.model)
    const body = this.buildRequestBody(options, wireMessages, found?.efforts ?? [])

    // 整体超时是安全网；空闲超时才是主要侦测手段。两者都必须存在，
    // 否则网关半开连接会让 generator 永不返回。
    const timeoutSignal = AbortSignal.timeout(this.options.requestTimeoutMs)
    const signal = options.signal !== undefined
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal

    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          ...attributionHeaders(),
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw options.signal.reason ?? error
      if (timeoutSignal.aborted) {
        throw new LlmError(`workbuddy2api: 请求整体超时（${this.options.requestTimeoutMs}ms）`, 'TIMEOUT')
      }
      if (isTransportError(error)) {
        throw new LlmError(
          `workbuddy2api: 无法连接网关 ${this.options.baseURL}（${errorMessage(error)}）。`
          + '请确认网关进程已启动（/wb2api-status）。',
          'TRANSPORT',
          { cause: error },
        )
      }
      throw error
    }

    if (!response.ok) {
      const detail = errorDetail(await response.text().catch(() => ''))
      throw new LlmError(
        `workbuddy2api: HTTP ${response.status} ${detail}`,
        httpErrorCode(response.status),
        { status: response.status },
      )
    }
    if (response.body === null) {
      throw new LlmError('workbuddy2api: 网关返回空响应体', 'PROVIDER_ERROR')
    }

    yield* this.consumeSse(response, options)
  }

  /** 解析 SSE 流并产出 `StreamChunk`。 */
  private async *consumeSse(response: Response, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const state: StreamState = {
      buffer: '',
      streamEnded: false,
      nextIndex: 0,
      toolIds: new Map(),
      toolCalls: new Map(),
      toolOrder: [],
    }
    let firstChunk = true

    try {
      while (!state.streamEnded) {
        const timeoutMs = firstChunk ? this.options.firstTokenTimeoutMs : this.options.idleTimeoutMs
        const phase: SsePhase = firstChunk ? 'first-token' : 'chunk'
        const { done, value } = await readWithIdleTimeout(reader, timeoutMs, 'workbuddy2api', options.signal, phase)
        if (done) break
        firstChunk = false
        state.buffer += decoder.decode(value, { stream: true })

        // 按 \n 切行（不按 \n\n 切事件）：网关一帧 = 一行 data:。
        // 跨 chunk 的残尾留在 buffer 里，下一轮拼接。
        let newlineIndex: number
        while (!state.streamEnded && (newlineIndex = state.buffer.indexOf('\n')) >= 0) {
          const line = state.buffer.slice(0, newlineIndex).trim()
          state.buffer = state.buffer.slice(newlineIndex + 1)
          if (line.length === 0) continue
          if (!line.startsWith('data:')) continue // event: / id: / 注释行静默丢弃
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') { state.streamEnded = true; break }
          let chunk: RawChunk
          try {
            chunk = JSON.parse(payload) as RawChunk
          } catch {
            continue // 非 JSON 帧（如心跳）静默跳过，不中断流
          }
          yield* consumeChunk(chunk, state)
        }
      }
    } finally {
      reader.releaseLock()
    }

    yield* this.finishStream(state)
  }

  /** 关闭所有块并发出终止 `finish`。 */
  private *finishStream(state: StreamState): Generator<StreamChunk> {
    // 先关闭工具块（按创建顺序），再文本块，再思考块。
    for (const index of state.toolOrder) {
      const block = [...state.toolCalls.values()].find(candidate => candidate.index === index)
      if (block === undefined) continue
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId),
          name: block.name ?? '',
          // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**，
          // 由下方 max-tokens 判定触发重试。把残缺 JSON 补成 {} 会伪造出合法外观，
          // 让 harness 报 missing required property 而非重试，掩盖真正的分片丢失。
          arguments: isTruncatedArguments(block.text) ? block.text : normalizeToolArguments(block.text),
        },
      }
    }
    if (state.text !== undefined) {
      yield { type: 'block-end', index: state.text.index, block: { type: 'text', text: state.text.text } }
    }
    if (state.reasoning !== undefined && state.reasoning.text !== '') {
      yield { type: 'block-end', index: state.reasoning.index, block: { type: 'reasoning', text: state.reasoning.text } }
    }

    // 三种「不完整」都必须报告 max-tokens 而非 tool-calls，否则 harness 会执行残缺
    // 调用、报 INVALID_ARGS，并把脏参数持久化进会话历史：
    //   - 'length'：模型输出被 max_tokens 显式截断；
    //   - 未收到 finish_reason 但有工具调用：连接被中途掐断，参数必然是半截 JSON；
    //   - 参数分片丢失：拼接结果无法解析。
    // 判定为截断后 dsh 丢弃残缺调用并重试。
    const argsTruncated = [...state.toolCalls.values()].some(block => isTruncatedArguments(block.text))
    const reason = state.finishReason === 'length'
      || (state.finishReason === undefined && state.toolOrder.length > 0)
      || argsTruncated
      ? { kind: 'max-tokens' as const }
      : state.finishReason === 'tool_calls' || state.toolOrder.length > 0
        ? { kind: 'tool-calls' as const }
        : { kind: 'stop' as const }
    yield { type: 'finish', reason }
  }
}

/**
 * 处理单条已解析的 SSE chunk，产出对应 delta 并更新累积状态。
 *
 * @param chunk - 已解析的 SSE chunk。
 * @param state - 流累积状态（原地更新）。
 * @returns 本次应产出的 chunk 序列。
 */
export function* consumeChunk(chunk: RawChunk, state: StreamState): Generator<StreamChunk> {
  const choice = chunk.choices?.[0]
  if (choice !== undefined) {
    if (typeof choice.finish_reason === 'string') {
      state.finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
    }
    const delta = choice.delta
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      if (state.text === undefined) {
        state.text = { index: state.nextIndex++, kind: 'text', text: '' }
        yield { type: 'block-start', index: state.text.index, blockType: 'text' }
      }
      state.text.text += delta.content
      yield { type: 'text-delta', index: state.text.index, text: delta.content }
    }
    // 思考链：上游可能用 reasoning_content（DeepSeek 风格）或 reasoning。
    const reasoningText = typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0
      ? delta.reasoning_content
      : typeof delta?.reasoning === 'string' && delta.reasoning.length > 0 ? delta.reasoning : undefined
    if (reasoningText !== undefined) {
      if (state.reasoning === undefined) {
        state.reasoning = { index: state.nextIndex++, kind: 'reasoning', text: '' }
        yield { type: 'block-start', index: state.reasoning.index, blockType: 'reasoning' }
      }
      state.reasoning.text += reasoningText
      yield { type: 'reasoning-delta', index: state.reasoning.index, text: reasoningText }
    }
    for (const call of delta?.tool_calls ?? []) {
      // 用线格式的 call.index 做 Map 键（不是数组位置）：并行工具调用时
      // 各调用的分片会交错下发，数组位置不稳定。
      const wireIndex = call.index ?? 0
      if (typeof call.id === 'string' && call.id.length > 0) state.toolIds.set(wireIndex, call.id)
      // id 只在首个分片出现，后续分片缺失，靠上面的 Map 复用；
      // 完全缺失时回退合成 id，保证 block-start / delta / block-end 三处一致。
      const callId = state.toolIds.get(wireIndex) ?? `call_${wireIndex}`
      let block = state.toolCalls.get(wireIndex)
      if (block === undefined) {
        block = { index: state.nextIndex++, text: '', callId }
        state.toolCalls.set(wireIndex, block)
        state.toolOrder.push(block.index)
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
      }
      block.callId = callId
      // 后续参数分片会带上空的 function.name（""），它不是 undefined，直接覆盖会把
      // 首个分片解析出的真实工具名清空，导致 `unknown tool ""`。只有非空名字才更新。
      if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
        block.name = call.function.name
      }
      const fragment = call.function?.arguments ?? ''
      block.text += fragment
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: ToolCallId(callId),
        ...block.name !== undefined ? { name: block.name } : {},
        argumentsDelta: fragment,
      }
    }
  }

  if (chunk.usage !== undefined && chunk.usage !== null) {
    yield { type: 'usage', usage: toTokenUsage(chunk.usage) }
  }
}

/**
 * OpenAI usage → dsh `TokenUsage`。
 *
 * 契约要求计数**互斥**：`inputTokens` 只计未命中缓存的输入，缓存命中单列
 * `cacheReadTokens`。上游把两者都折进 `prompt_tokens`，因此这里必须减出来，
 * 否则缓存命中率会被算大。
 *
 * @param usage - 原始 usage。
 * @returns dsh `TokenUsage`。
 */
export function toTokenUsage(usage: RawUsage): TokenUsage {
  const promptTokens = usage.prompt_tokens ?? 0
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: cachedTokens > 0 ? Math.max(0, promptTokens - cachedTokens) : promptTokens,
    outputTokens: usage.completion_tokens ?? 0,
    ...usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {},
    ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
    ...cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
    ...reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {},
  }
}
