import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  collectImageRefs,
  consumeChunk,
  contentToText,
  errorDetail,
  GatewayAdapter,
  httpErrorCode,
  isTransportError,
  serializeMessages,
  toTokenUsage,
} from '../../src/gateway-adapter.js'
import { mapModelCatalog, ModelCatalog } from '../../src/models.js'
import { PROVIDER } from '../../src/config.js'

/** 构造一个只喂给内存 SSE 文本的 adapter。 */
function makeAdapter(
  sse: string,
  models: unknown[] = [{ id: 'cn:deepseek-v4.1-flash', context_length: 1000000, max_output_tokens: 128000 }],
  init?: { status?: number; body?: string },
) {
  const catalog = new ModelCatalog({
    ttlMs: 60_000,
    fetchCatalog: async () => mapModelCatalog({ data: models }, 'strip-cn'),
  })
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const fetchImpl = (async (url: string | URL, request?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(request?.body ?? '{}')) as Record<string, unknown>,
      headers: (request?.headers ?? {}) as Record<string, string>,
    })
    if (init?.status !== undefined && init.status !== 200) {
      return new Response(init.body ?? '{"error":{"message":"boom"}}', { status: init.status })
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse))
        controller.close()
      },
    })
    return new Response(stream, { status: 200 })
  }) as unknown as typeof fetch

  const adapter = new GatewayAdapter({
    providerId: PROVIDER,
    baseURL: 'http://127.0.0.1:7863/v1',
    catalog,
    resolveApiKey: async () => 'test-key',
    fetchImpl,
    requestTimeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    firstTokenTimeoutMs: 60_000,
  })
  return { adapter, requests, catalog }
}

/** 把生成器收成全数组。 */
async function drain(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/** 把 SSE 事件拼成 wire 文本。 */
function sseOf(...events: unknown[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

const baseOptions: GenerateOptions = {
  provider: PROVIDER,
  model: 'deepseek-v4.1-flash',
  messages: [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
  ] as never,
}

describe('contentToText', () => {
  it('字符串直通（历史里存在纯字符串 content）', () => {
    expect(contentToText('hello')).toBe('hello')
  })

  it('拼接 text 块，忽略其他块', () => {
    expect(contentToText([
      { type: 'text', text: 'a' },
      { type: 'reasoning', text: 'skip' },
      { type: 'text', text: 'b' },
    ])).toBe('ab')
  })

  it('非数组返回空串', () => {
    expect(contentToText(undefined)).toBe('')
    expect(contentToText(42)).toBe('')
  })
})

describe('collectImageRefs', () => {
  it('收集 image 块的 attachment', () => {
    const ref = { id: 'img1' }
    const into: unknown[] = []
    collectImageRefs([{ type: 'text', text: 'x' }, { type: 'image', attachment: ref }], into)
    expect(into).toEqual([ref])
  })

  it('无 attachment 的 image 块被跳过', () => {
    const into: unknown[] = []
    collectImageRefs([{ type: 'image' }], into)
    expect(into).toEqual([])
  })
})

describe('serializeMessages', () => {
  it('tool-result 展开为独立 role:tool 消息', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":1}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
    ])
    expect(wire).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ])
  })

  it('纯工具结果的 user 消息不产生空 user 条目', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
    ])
    expect(wire.filter(message => message.role === 'user')).toHaveLength(0)
  })

  it('正文为空且有 tool_calls 时 content 为 null', () => {
    // 必须给出配对的结果，否则该 tool_call 会被当作孤儿剔除，测不到 null 分支。
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
    ])
    expect(wire[0]?.content).toBeNull()
  })

  it('无配对结果时 tool_call 被剔除，content 落回空串', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
    ])
    expect(wire[0]?.content).toBe('')
    expect('tool_calls' in (wire[0] ?? {})).toBe(false)
  })

  it('reasoning 块折叠为 reasoning_content', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '答' }] },
    ])
    expect(wire[0]).toMatchObject({ role: 'assistant', content: '答', reasoning_content: '思考' })
  })

  it('无 reasoning 时不发 reasoning_content 字段', () => {
    const wire = serializeMessages([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }])
    expect('reasoning_content' in (wire[0] ?? {})).toBe(false)
  })

  it('system 角色原样输出', () => {
    const wire = serializeMessages([{ role: 'system', content: 'sys' }])
    expect(wire).toEqual([{ role: 'system', content: 'sys' }])
  })

  it('孤儿工具调用与其结果一并剔除（会话自愈）', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'orphan', name: 'read', arguments: '{"a":' }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ])
    expect(wire[0]).toMatchObject({ role: 'assistant', content: '' })
    expect('tool_calls' in (wire[0] ?? {})).toBe(false)
  })

  it('工具结果的空输出补占位文本', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 't', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] },
    ])
    expect(wire[1]).toMatchObject({ role: 'tool', content: '(no output)' })
  })

  it('残留的残缺 arguments 在回放时被归一化为 {}', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 't', arguments: '{"a":' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }] },
    ])
    const calls = (wire[0]?.tool_calls as Array<{ function: { arguments: string } }>)
    expect(calls[0]?.function.arguments).toBe('{}')
  })

  it('图片在提供 data URL 时升级为多模态 parts', () => {
    const ref = { id: 'img1' }
    const urls = new Map<unknown, string>([[ref, 'data:image/png;base64,AAA']])
    const wire = serializeMessages([
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: ref }] },
    ], urls)
    expect(wire[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ])
  })

  it('图片 URL 缺失时降级为纯文本（不发空 URL）', () => {
    const ref = { id: 'img1' }
    const wire = serializeMessages([
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: ref }] },
    ], new Map())
    expect(wire[0]?.content).toBe('看图')
  })

  it('无文本的多模态消息只含 image part', () => {
    const ref = { id: 'img1' }
    const urls = new Map<unknown, string>([[ref, 'data:image/png;base64,AAA']])
    const wire = serializeMessages([{ role: 'user', content: [{ type: 'image', attachment: ref }] }], urls)
    expect(wire[0]?.content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }])
  })
})

describe('errorDetail / httpErrorCode / isTransportError', () => {
  it('提取 error.message', () => {
    expect(errorDetail('{"error":{"message":"bad key"}}')).toBe('bad key')
  })

  it('提取字符串 error', () => {
    expect(errorDetail('{"error":"oops"}')).toBe('oops')
  })

  it('提取顶层 message', () => {
    expect(errorDetail('{"message":"nope"}')).toBe('nope')
  })

  it('非 JSON 体截断返回', () => {
    expect(errorDetail('plain text')).toBe('plain text')
  })

  it('状态码映射', () => {
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(403)).toBe('AUTH')
    expect(httpErrorCode(429)).toBe('RATE_LIMIT')
    expect(httpErrorCode(408)).toBe('TIMEOUT')
    expect(httpErrorCode(504)).toBe('TIMEOUT')
    expect(httpErrorCode(500)).toBe('PROVIDER_ERROR')
    expect(httpErrorCode(502)).toBe('PROVIDER_ERROR')
    expect(httpErrorCode(400)).toBe('INVALID_REQUEST')
    expect(httpErrorCode(404)).toBe('PROVIDER_ERROR')
  })

  it('连接类错误判定为传输错误', () => {
    const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    expect(isTransportError(refused)).toBe(true)
    expect(isTransportError(new TypeError('fetch failed'))).toBe(true)
    expect(isTransportError(new Error('other'))).toBe(false)
    // AbortError 属于用户取消，不是传输故障。
    expect(isTransportError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false)
  })
})

describe('toTokenUsage', () => {
  it('缓存命中从 inputTokens 里减出并单列', () => {
    const usage = toTokenUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
    })
    expect(usage.inputTokens).toBe(200)
    expect(usage.cacheReadTokens).toBe(800)
    expect(usage.outputTokens).toBe(50)
    expect(usage.totalTokens).toBe(1050)
  })

  it('无缓存时不声明 cacheReadTokens', () => {
    const usage = toTokenUsage({ prompt_tokens: 10, completion_tokens: 2 })
    expect(usage.inputTokens).toBe(10)
    expect('cacheReadTokens' in usage).toBe(false)
    expect('totalTokens' in usage).toBe(false)
  })

  it('prompt_cache_hit_tokens 作为退路', () => {
    const usage = toTokenUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 40 })
    expect(usage.inputTokens).toBe(60)
    expect(usage.cacheReadTokens).toBe(40)
  })

  it('reasoning / cacheWrite 只在正数时声明', () => {
    const usage = toTokenUsage({
      prompt_tokens: 5,
      completion_tokens: 5,
      prompt_tokens_details: { cache_write_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 7 },
    })
    expect(usage.cacheWriteTokens).toBe(3)
    expect(usage.reasoningTokens).toBe(7)
  })

  it('缓存数大于 prompt 数时不会出现负数', () => {
    const usage = toTokenUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 30 } })
    expect(usage.inputTokens).toBe(0)
  })
})

describe('consumeChunk', () => {
  const state = () => ({
    buffer: '',
    streamEnded: false,
    nextIndex: 0,
    toolIds: new Map<number, string>(),
    toolCalls: new Map<number, { index: number; text: string; callId: string; name?: string }>(),
    toolOrder: [] as number[],
  })

  it('文本 delta 先发 block-start', () => {
    const chunks = [...consumeChunk({ choices: [{ delta: { content: 'hi' } }] }, state())]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
    ])
  })

  it('reasoning_content 映射为 reasoning-delta', () => {
    const chunks = [...consumeChunk({ choices: [{ delta: { reasoning_content: '想' } }] }, state())]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '想' },
    ])
  })

  it('reasoning 字段同样被识别', () => {
    const chunks = [...consumeChunk({ choices: [{ delta: { reasoning: '想' } }] }, state())]
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: '想' })
  })

  it('工具 id 只在首帧出现，后续分片复用同一 id', () => {
    const shared = state()
    const first = [...consumeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'read', arguments: '{"a"' } }] } }],
    }, shared)]
    const second = [...consumeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }],
    }, shared)]
    expect(first[1]).toMatchObject({ type: 'tool-call-delta', id: 'call_abc', name: 'read', argumentsDelta: '{"a"' })
    expect(second[0]).toMatchObject({ type: 'tool-call-delta', id: 'call_abc', argumentsDelta: ':1}' })
    // 第二帧只有 delta，不再重复 block-start，故长度为 1 且下标为 0。
    expect(second).toHaveLength(1)
  })

  it('后续分片的空 function.name 不清空已解析的真实工具名', () => {
    const shared = state()
    ;[...consumeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '' } }] } }],
    }, shared)]
    const next = [...consumeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '{}' } }] } }],
    }, shared)]
    expect(next[0]).toMatchObject({ name: 'read' })
    expect(shared.toolCalls.get(0)?.name).toBe('read')
  })

  it('缺少 id 时回退合成 id', () => {
    const chunks = [...consumeChunk({
      choices: [{ delta: { tool_calls: [{ index: 2, function: { name: 't', arguments: '{}' } }] } }],
    }, state())]
    expect(chunks[1]).toMatchObject({ id: 'call_2' })
  })

  it('并行工具调用按 index 各自建块', () => {
    const shared = state()
    const chunks = [...consumeChunk({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'a', function: { name: 'read', arguments: '{}' } },
            { index: 1, id: 'b', function: { name: 'write', arguments: '{}' } },
          ],
        },
      }],
    }, shared)]
    const starts = chunks.filter(chunk => chunk.type === 'block-start')
    expect(starts).toHaveLength(2)
    expect(shared.toolCalls.size).toBe(2)
  })

  it('finish_reason 写入状态', () => {
    const shared = state()
    ;[...consumeChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, shared)]
    expect(shared.finishReason).toBe('tool_calls')
  })

  it('usage 产出 usage chunk', () => {
    const chunks = [...consumeChunk({ usage: { prompt_tokens: 3, completion_tokens: 1 } }, state())]
    expect(chunks).toEqual([{ type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }])
  })

  it('空 delta 不产出任何 chunk', () => {
    expect([...consumeChunk({ choices: [{ delta: {} }] }, state())]).toEqual([])
  })
})

describe('GatewayAdapter.stream（端到端 SSE 翻译）', () => {
  it('文本响应产出 block-start / delta / block-end / finish', async () => {
    const { adapter } = makeAdapter(sseOf(
      { choices: [{ delta: { content: '你' } }] },
      { choices: [{ delta: { content: '好' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ))
    const chunks = await drain(adapter.stream(baseOptions))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你' },
      { type: 'text-delta', index: 0, text: '好' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('思考链与正文并存时各自成块', async () => {
    const { adapter } = makeAdapter(sseOf(
      { choices: [{ delta: { reasoning_content: '思考中' } }] },
      { choices: [{ delta: { content: '答案' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ))
    const chunks = await drain(adapter.stream(baseOptions))
    const types = chunks.map(chunk => chunk.type)
    expect(types).toContain('reasoning-delta')
    const blockEnds = chunks.filter(chunk => chunk.type === 'block-end')
    expect(blockEnds).toHaveLength(2)
  })

  it('工具调用产出配对正确的 tool-call 块并报 tool-calls', async () => {
    const { adapter } = makeAdapter(sseOf(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ))
    const chunks = await drain(adapter.stream(baseOptions))
    const end = chunks.find(chunk => chunk.type === 'block-end')
    expect(end).toMatchObject({
      block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('残缺工具参数报 max-tokens 而非 tool-calls（触发重试而非执行脏调用）', async () => {
    const { adapter } = makeAdapter(sseOf(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path"' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ))
    const chunks = await drain(adapter.stream(baseOptions))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    // 残缺参数必须保持原样，不得被补成 {}。
    const end = chunks.find(chunk => chunk.type === 'block-end')
    expect(end).toMatchObject({ block: { arguments: '{"path"' } })
  })

  it('无参数工具的空分片补成 {}', async () => {
    const { adapter } = makeAdapter(sseOf(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_dir', arguments: '' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ))
    const chunks = await drain(adapter.stream(baseOptions))
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({ block: { arguments: '{}' } })
  })

  it('未收到 finish_reason 但有工具调用时报 max-tokens', async () => {
    const { adapter } = makeAdapter(sseOf(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 't', arguments: '{}' } }] } }] },
    ))
    const chunks = await drain(adapter.stream(baseOptions))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('finish_reason=length 报 max-tokens', async () => {
    const { adapter } = makeAdapter(sseOf(
      { choices: [{ delta: { content: 'x' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ))
    const chunks = await drain(adapter.stream(baseOptions))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('usage 帧被翻译', async () => {
    const { adapter } = makeAdapter(sseOf(
      { choices: [{ delta: { content: 'x' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
    ))
    const chunks = await drain(adapter.stream(baseOptions))
    const usage = chunks.find(chunk => chunk.type === 'usage')
    expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4 } })
  })

  it('按 \\n 切行：一帧跨多个 chunk 边界也能解析', async () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: '拆分' } }] })
    const catalog = new ModelCatalog({
      ttlMs: 60_000,
      fetchCatalog: async () => mapModelCatalog({ data: [{ id: 'cn:deepseek-v4.1-flash' }] }, 'strip-cn'),
    })
    const encoder = new TextEncoder()
    // 故意把一帧切成三段，且切在多字节字符中间。
    const bytes = encoder.encode(`data: ${payload}\n\ndata: [DONE]\n\n`)
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10))
        controller.enqueue(bytes.slice(10, 25))
        controller.enqueue(bytes.slice(25))
        controller.close()
      },
    }), { status: 200 })) as unknown as typeof fetch
    const adapter = new GatewayAdapter({
      providerId: PROVIDER,
      baseURL: 'http://127.0.0.1:7863/v1',
      catalog,
      resolveApiKey: async () => 'k',
      fetchImpl,
      requestTimeoutMs: 5000,
      idleTimeoutMs: 5000,
      firstTokenTimeoutMs: 5000,
    })
    const chunks = await drain(adapter.stream(baseOptions))
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: '拆分' } })
  })

  it('非 JSON 帧与注释行被静默跳过', async () => {
    const sse = ': keep-alive\n\n'
      + 'data: not-json\n\n'
      + `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`
      + 'data: [DONE]\n\n'
    const { adapter } = makeAdapter(sse)
    const chunks = await drain(adapter.stream(baseOptions))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('请求发往 <baseURL>/chat/completions 且带 Bearer 鉴权', async () => {
    const { adapter, requests } = makeAdapter(sseOf({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    await drain(adapter.stream(baseOptions))
    expect(requests[0]?.url).toBe('http://127.0.0.1:7863/v1/chat/completions')
    expect(requests[0]?.headers.authorization).toBe('Bearer test-key')
  })

  it('请求体：裸模型名补成 cn: 前缀（消除 realm 路由歧义）', async () => {
    const { adapter, requests } = makeAdapter(sseOf({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    await drain(adapter.stream(baseOptions))
    expect(requests[0]?.body.model).toBe('cn:deepseek-v4.1-flash')
  })

  it('请求体：system 作为 messages 首条插入', async () => {
    const { adapter, requests } = makeAdapter(sseOf({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    await drain(adapter.stream({ ...baseOptions, system: '你是助手' }))
    const messages = requests[0]?.body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: '你是助手' })
  })

  it('请求体：tools / temperature / max_tokens / stop 映射正确', async () => {
    const { adapter, requests } = makeAdapter(sseOf({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    await drain(adapter.stream({
      ...baseOptions,
      temperature: 0.3,
      maxTokens: 512,
      stop: ['END'],
      tools: [{ name: 'read', description: 'd', parameters: { type: 'object' } }],
    }))
    const body = requests[0]?.body
    expect(body?.temperature).toBe(0.3)
    expect(body?.max_tokens).toBe(512)
    expect(body?.stop).toEqual(['END'])
    expect(body?.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } },
    ])
    expect(body?.stream).toBe(true)
  })

  it('请求体：无 tools 时不发该字段（不是空数组）', async () => {
    const { adapter, requests } = makeAdapter(sseOf({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    await drain(adapter.stream(baseOptions))
    expect('tools' in (requests[0]?.body ?? {})).toBe(false)
  })

  it('请求体：reasoningEffort 在白名单内才发', async () => {
    const models = [{
      id: 'cn:m',
      reasoning_supported_efforts: ['low', 'high'],
      reasoning_default_effort: 'high',
    }]
    const options = { ...baseOptions, model: 'm' }
    const ok = makeAdapter(sseOf({ choices: [{ delta: {}, finish_reason: 'stop' }] }), models)
    await drain(ok.adapter.stream({ ...options, reasoningEffort: 'high' as never }))
    expect(ok.requests[0]?.body.reasoning_effort).toBe('high')

    const bad = makeAdapter(sseOf({ choices: [{ delta: {}, finish_reason: 'stop' }] }), models)
    await drain(bad.adapter.stream({ ...options, reasoningEffort: 'ultra' as never }))
    expect('reasoning_effort' in (bad.requests[0]?.body ?? {})).toBe(false)
  })

  it('HTTP 错误映射为带 code 的 LlmError', async () => {
    const { adapter } = makeAdapter('', [], { status: 401, body: '{"error":{"message":"bad key"}}' })
    await expect(drain(adapter.stream(baseOptions))).rejects.toMatchObject({
      code: 'AUTH',
      message: expect.stringContaining('bad key'),
    })
  })

  it('429 归类为可重试的 RATE_LIMIT', async () => {
    const { adapter } = makeAdapter('', [], { status: 429 })
    await expect(drain(adapter.stream(baseOptions))).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('未配置 api_key 时抛 MISSING_CREDENTIAL', async () => {
    const catalog = new ModelCatalog({ ttlMs: 1000, fetchCatalog: async () => [] })
    const adapter = new GatewayAdapter({
      providerId: PROVIDER,
      baseURL: 'http://127.0.0.1:7863/v1',
      catalog,
      resolveApiKey: async () => undefined,
      requestTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      firstTokenTimeoutMs: 1000,
    })
    await expect(drain(adapter.stream(baseOptions))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('网关不可达时报 TRANSPORT 并给出可操作提示', async () => {
    const catalog = new ModelCatalog({ ttlMs: 1000, fetchCatalog: async () => [] })
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }) as unknown as typeof fetch
    const adapter = new GatewayAdapter({
      providerId: PROVIDER,
      baseURL: 'http://127.0.0.1:7863/v1',
      catalog,
      resolveApiKey: async () => 'k',
      fetchImpl,
      requestTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      firstTokenTimeoutMs: 1000,
    })
    await expect(drain(adapter.stream(baseOptions))).rejects.toMatchObject({
      code: 'TRANSPORT',
      message: expect.stringContaining('/wb2api-status'),
    })
  })

  it('空响应体报 PROVIDER_ERROR', async () => {
    const catalog = new ModelCatalog({ ttlMs: 1000, fetchCatalog: async () => [] })
    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    const adapter = new GatewayAdapter({
      providerId: PROVIDER,
      baseURL: 'http://127.0.0.1:7863/v1',
      catalog,
      resolveApiKey: async () => 'k',
      fetchImpl,
      requestTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      firstTokenTimeoutMs: 1000,
    })
    await expect(drain(adapter.stream(baseOptions))).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })
})

describe('GatewayAdapter 元数据方法', () => {
  const models = [
    {
      id: 'cn:deepseek-v4.1-flash',
      context_length: 1000000,
      max_output_tokens: 128000,
      supports_images: true,
      reasoning_supported_efforts: ['low', 'high', 'max'],
      reasoning_default_effort: 'high',
    },
    { id: 'cn:glm-5.1', context_length: 200000, max_output_tokens: 48000 },
    { id: 'global:gpt-5.4', context_length: 131072, reasoning_supported_efforts: ['high'], reasoning_default_effort: 'high' },
  ]

  const make = () => makeAdapter('', models).adapter

  it('providerInfo 的 id 必须等于注册的路由名', () => {
    expect(make().providerInfo(PROVIDER)).toEqual({ id: PROVIDER, name: expect.any(String) })
  })

  it('providerInfo 对非法入参做防御性归一化', () => {
    expect(make().providerInfo(undefined as never).id).toBe(PROVIDER)
    expect(make().providerInfo('').id).toBe(PROVIDER)
  })

  it('listModels 暴露全部模型且 provider 字段正确', async () => {
    const list = await make().listModels(PROVIDER)
    expect(list.map(model => model.id)).toEqual(['deepseek-v4.1-flash', 'glm-5.1', 'global:gpt-5.4'])
    expect(list.every(model => model.provider === PROVIDER)).toBe(true)
  })

  it('inputModalities：supports_images 决定 text/image', async () => {
    const list = await make().listModels(PROVIDER)
    expect(list.find(model => model.id === 'deepseek-v4.1-flash')?.inputModalities).toEqual(['text', 'image'])
    expect(list.find(model => model.id === 'glm-5.1')?.inputModalities).toEqual(['text'])
  })

  it('global 模型带 description 以便与同名 CN 模型区分', async () => {
    const list = await make().listModels(PROVIDER)
    expect(list.find(model => model.id === 'global:gpt-5.4')?.description).toContain('global')
  })

  it('resolveModel 返回 context / defaultMaxTokens / reasoning', async () => {
    const resolved = await make().resolveModel(PROVIDER, 'deepseek-v4.1-flash')
    expect(resolved.context).toEqual({ contextWindow: 1000000 })
    expect(resolved.defaultMaxTokens).toBe(128000)
    expect(resolved.reasoning?.efforts.map(effort => String(effort.id))).toEqual(['low', 'high', 'max'])
    expect(String(resolved.reasoning?.defaultEffort)).toBe('high')
  })

  it('无 max_output_tokens 时不声明 defaultMaxTokens', async () => {
    const resolved = await make().resolveModel(PROVIDER, 'global:gpt-5.4')
    expect('defaultMaxTokens' in resolved).toBe(false)
  })

  it('无档位时不声明 reasoning（UI 显示「未提供推理等级」）', async () => {
    const resolved = await make().resolveModel(PROVIDER, 'glm-5.1')
    expect('reasoning' in resolved).toBe(false)
  })

  it('未知模型回退到兜底窗口而不抛错（契约：不校验路由）', async () => {
    const resolved = await make().resolveModel(PROVIDER, 'does-not-exist')
    expect(resolved).toMatchObject({ provider: PROVIDER, id: 'does-not-exist', name: 'does-not-exist' })
    // 兜底值对齐网关四级查找的 DefaultContextWindow（1M），见 src/models.ts。
    expect(resolved.context?.contextWindow).toBe(1000000)
  })

  it('prepareCall 绑定模型元数据与同一个适配器实例的 stream', async () => {
    const adapter = make()
    const prepared = await adapter.prepareCall(PROVIDER, 'deepseek-v4.1-flash')
    expect(prepared.model.id).toBe('deepseek-v4.1-flash')
    expect(typeof prepared.stream).toBe('function')
  })
})
