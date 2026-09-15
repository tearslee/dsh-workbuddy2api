/**
 * 针对**真实运行中的网关**的集成冒烟测试。
 *
 * 默认跳过 —— 需要网关在 127.0.0.1:7863 上运行，并需要有效 api_key。
 * 启用方式：
 *
 *   $env:DSH_WB2API_E2E = '1'
 *   $env:DSH_WB2API_E2E_CONFIRM = 'yes'
 *
 * 它会真实发起一次对话（消耗账号额度），所以必须显式二次确认。
 */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GatewayAdapter } from '../../src/gateway-adapter.js'
import { mapModelCatalog, ModelCatalog, toWireModel } from '../../src/models.js'
import { resolveConfig } from '../../src/config.js'

const ENABLED = process.env.DSH_WB2API_E2E === '1' && process.env.DSH_WB2API_E2E_CONFIRM === 'yes'
const BASE_URL = process.env.DSH_WB2API_E2E_BASE_URL ?? 'http://127.0.0.1:7863/v1'
const API_KEY = process.env.DSH_WB2API_E2E_API_KEY ?? ''

const config = resolveConfig({ baseURL: BASE_URL, apiKeyRef: '' })

const catalog = new ModelCatalog({
  ttlMs: 60_000,
  fetchCatalog: async () => {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: API_KEY.length > 0 ? { authorization: `Bearer ${API_KEY}` } : {},
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return mapModelCatalog(await response.json(), config.realmPrefixPolicy)
  },
})

const adapter = new GatewayAdapter({
  providerId: 'workbuddy2api',
  baseURL: BASE_URL,
  catalog,
  resolveApiKey: async () => API_KEY,
  requestTimeoutMs: 300_000,
  idleTimeoutMs: 120_000,
  firstTokenTimeoutMs: 60_000,
})

async function drain(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

describe.skipIf(!ENABLED)('live gateway 集成', () => {
  it('/healthz 可达且结构正确', async () => {
    const response = await fetch(BASE_URL.replace(/\/v1$/, '') + '/healthz')
    expect(response.ok).toBe(true)
    const body = await response.json() as { healthy?: number; total?: number; service?: string }
    expect(body.service).toBe('workbuddy2api')
    expect(typeof body.healthy).toBe('number')
    expect(typeof body.total).toBe('number')
  })

  it('/v1/models 返回带扩展元数据的目录', async () => {
    const models = await catalog.get(true)
    expect(models.length).toBeGreaterThan(0)
    // 至少有一个模型给出多模态能力（实测 CN 侧绝大多数支持图片）。
    expect(models.some(model => model.supportsImages)).toBe(true)
    // 至少有一个模型给出真实上下文窗口（非占位 131072）。
    expect(models.some(model => model.contextWindow !== 131072)).toBe(true)
  })

  it('listModels / resolveModel 与 /v1/models 一致', async () => {
    const raw = await (async () => {
      const response = await fetch(`${BASE_URL}/models`, {
        headers: API_KEY.length > 0 ? { authorization: `Bearer ${API_KEY}` } : {},
      })
      return await response.json() as { data: Array<{ id: string; context_length?: number; max_output_tokens?: number }> }
    })()
    const expected = mapModelCatalog(raw, config.realmPrefixPolicy)
    const listed = await adapter.listModels('workbuddy2api')
    expect(listed.map(model => model.id)).toEqual(expected.map(model => model.id))

    // 抽查第一个带 max_output_tokens 的模型的完整解析。
    const sample = expected.find(model => model.maxOutputTokens !== undefined)
    expect(sample).toBeDefined()
    const resolved = await adapter.resolveModel('workbuddy2api', sample!.id)
    expect(resolved.context?.contextWindow).toBe(sample!.contextWindow)
    expect(resolved.defaultMaxTokens).toBe(sample!.maxOutputTokens)
  })

  it('真实对话：文本流正常结束', async () => {
    const models = await catalog.get()
    const model = models.find(candidate => candidate.efforts.length === 0) ?? models[0]!
    const options: GenerateOptions = {
      provider: 'workbuddy2api',
      model: model.id,
      maxTokens: 64,
      messages: [{
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: '只回复两个字：收到' }],
        source: { kind: 'user' },
      }] as never,
    }
    const chunks = await drain(adapter.stream(options))
    const text = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end')
      .filter(chunk => chunk.block.type === 'text')
      .map(chunk => chunk.block.type === 'text' ? chunk.block.text : '')
      .join('')
    expect(text.length).toBeGreaterThan(0)
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    expect(['stop', 'max-tokens']).toContain(finish?.type === 'finish' ? finish.reason.kind : '')
  })

  it('真实对话：带工具调用时块配对正确', async () => {
    const options: GenerateOptions = {
      provider: 'workbuddy2api',
      model: (await catalog.get())[0]!.id,
      maxTokens: 256,
      tools: [{
        name: 'get_weather',
        description: '查询指定城市天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名' } },
          required: ['city'],
        },
      }],
      messages: [{
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: '北京天气怎么样？必须调用 get_weather 工具。' }],
        source: { kind: 'user' },
      }] as never,
    }
    const chunks = await drain(adapter.stream(options))
    const toolEnds = chunks.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> =>
        chunk.type === 'block-end' && chunk.block.type === 'tool-call',
    )
    // 模型可能选择不调用工具，因此不断言一定有；有则必须结构完整。
    for (const end of toolEnds) {
      if (end.block.type !== 'tool-call') continue
      expect(end.block.name.length).toBeGreaterThan(0)
      expect(end.block.id.length).toBeGreaterThan(0)
      expect(() => JSON.parse(end.block.arguments)).not.toThrow()
    }
  })

  it('toWireModel 对目录里的每个 id 都能还原成网关可路由的形态', async () => {
    const models = await catalog.get()
    for (const model of models) {
      const wire = toWireModel(model.id)
      expect(wire).toMatch(/^(cn|global):.+/)
    }
  })
})
