import { describe, expect, it } from 'vitest'
import {
  CONTEXT_WINDOW_FALLBACK,
  mapModel,
  mapModelCatalog,
  ModelCatalog,
  parseModelId,
  toWireModel,
} from '../../src/models.js'
import { DEFAULT_CONFIG, gatewayOrigin, gatewayPort, resolveConfig } from '../../src/config.js'

describe('parseModelId', () => {
  it('剥出 cn / global 前缀', () => {
    expect(parseModelId('cn:deepseek-v4.1-flash')).toEqual({ realm: 'cn', bareId: 'deepseek-v4.1-flash' })
    expect(parseModelId('global:gpt-5.4')).toEqual({ realm: 'global', bareId: 'gpt-5.4' })
  })

  it('无前缀时 realm 落到 cn（与网关 resolveModel 对称）', () => {
    expect(parseModelId('deepseek-v4.1-flash')).toEqual({ realm: 'cn', bareId: 'deepseek-v4.1-flash' })
  })

  it('非 realm 前缀不剥离，整串视为裸名', () => {
    // 大小写敏感：网关 resolve_model.go:19 只认精确小写枚举。
    expect(parseModelId('CN:foo')).toEqual({ realm: 'cn', bareId: 'CN:foo' })
    expect(parseModelId('other:foo')).toEqual({ realm: 'cn', bareId: 'other:foo' })
  })

  it('只取第一个冒号', () => {
    expect(parseModelId('cn:a:b')).toEqual({ realm: 'cn', bareId: 'a:b' })
  })
})

describe('toWireModel', () => {
  it('无前缀 id 补 cn: —— 消除 realm 路由歧义', () => {
    expect(toWireModel('glm-5.3')).toBe('cn:glm-5.3')
  })

  it('已有前缀保持不变', () => {
    expect(toWireModel('cn:hy3')).toBe('cn:hy3')
    expect(toWireModel('global:gpt-5.4')).toBe('global:gpt-5.4')
  })

  it('非 realm 前缀被当作裸名并补 cn:', () => {
    expect(toWireModel('other:foo')).toBe('cn:other:foo')
  })
})

describe('mapModel', () => {
  const full = {
    id: 'cn:deepseek-v4.1-flash',
    context_length: 1000000,
    max_output_tokens: 128000,
    supports_images: true,
    reasoning_supported_efforts: ['low', 'high', 'max'],
    reasoning_default_effort: 'high',
  }

  it('映射全部标准字段', () => {
    const model = mapModel(full, 'strip-cn')
    expect(model).toBeDefined()
    expect(model?.id).toBe('deepseek-v4.1-flash')
    expect(model?.bareId).toBe('deepseek-v4.1-flash')
    expect(model?.realm).toBe('cn')
    expect(model?.contextWindow).toBe(1000000)
    expect(model?.maxOutputTokens).toBe(128000)
    expect(model?.supportsImages).toBe(true)
    expect(model?.efforts).toEqual(['low', 'high', 'max'])
    expect(model?.defaultEffort).toBe('high')
  })

  it('strip-cn 策略保留 global: 前缀（否则国际版账号路由不到）', () => {
    const model = mapModel({ id: 'global:gpt-5.4', context_length: 131072 }, 'strip-cn')
    expect(model?.id).toBe('global:gpt-5.4')
    expect(model?.bareId).toBe('gpt-5.4')
    expect(model?.realm).toBe('global')
  })

  it('keep 策略原样透出两种前缀', () => {
    expect(mapModel({ id: 'cn:hy3' }, 'keep')?.id).toBe('cn:hy3')
    expect(mapModel({ id: 'global:hy3' }, 'keep')?.id).toBe('global:hy3')
  })

  it('context_length 缺失 / 非正数时用网关同款兜底值', () => {
    expect(mapModel({ id: 'cn:a' }, 'strip-cn')?.contextWindow).toBe(CONTEXT_WINDOW_FALLBACK)
    expect(mapModel({ id: 'cn:a', context_length: 0 }, 'strip-cn')?.contextWindow).toBe(CONTEXT_WINDOW_FALLBACK)
    expect(mapModel({ id: 'cn:a', context_length: -5 }, 'strip-cn')?.contextWindow).toBe(CONTEXT_WINDOW_FALLBACK)
    expect(mapModel({ id: 'cn:a', context_length: 'x' }, 'strip-cn')?.contextWindow).toBe(CONTEXT_WINDOW_FALLBACK)
  })

  it('max_output_tokens 缺失时不声明（而不是写 0）', () => {
    const model = mapModel({ id: 'global:gpt-5.4', context_length: 131072 }, 'strip-cn')
    expect(model?.maxOutputTokens).toBeUndefined()
    expect('maxOutputTokens' in (model ?? {})).toBe(false)
  })

  it('supports_images 缺席即仅文本（显式否定能力）', () => {
    expect(mapModel({ id: 'cn:a' }, 'strip-cn')?.supportsImages).toBe(false)
    expect(mapModel({ id: 'cn:a', supports_images: false }, 'strip-cn')?.supportsImages).toBe(false)
    // 非布尔真值不算支持。
    expect(mapModel({ id: 'cn:a', supports_images: 'yes' }, 'strip-cn')?.supportsImages).toBe(false)
  })

  it('defaultEffort 不在 efforts 内时必须丢弃', () => {
    const model = mapModel({
      id: 'cn:a',
      reasoning_supported_efforts: ['low', 'high'],
      reasoning_default_effort: 'max',
    }, 'strip-cn')
    expect(model?.efforts).toEqual(['low', 'high'])
    expect(model?.defaultEffort).toBeUndefined()
    expect('defaultEffort' in (model ?? {})).toBe(false)
  })

  it('efforts 为空时不声明 defaultEffort', () => {
    const model = mapModel({ id: 'cn:a', reasoning_default_effort: 'high' }, 'strip-cn')
    expect(model?.efforts).toEqual([])
    expect(model?.defaultEffort).toBeUndefined()
  })

  it('efforts 里的非字符串元素被过滤', () => {
    const model = mapModel({ id: 'cn:a', reasoning_supported_efforts: ['low', 1, null, '', 'high'] }, 'strip-cn')
    expect(model?.efforts).toEqual(['low', 'high'])
  })

  it('id 非法时返回 undefined', () => {
    expect(mapModel({}, 'strip-cn')).toBeUndefined()
    expect(mapModel({ id: '' }, 'strip-cn')).toBeUndefined()
    expect(mapModel({ id: 123 }, 'strip-cn')).toBeUndefined()
    expect(mapModel({ id: 'cn:' }, 'strip-cn')).toBeUndefined()
  })
})

describe('mapModelCatalog', () => {
  it('解析 data 数组并保持顺序', () => {
    const catalog = mapModelCatalog({
      object: 'list',
      data: [{ id: 'cn:a' }, { id: 'cn:b' }, { id: 'global:c' }],
    }, 'strip-cn')
    expect(catalog.map(model => model.id)).toEqual(['a', 'b', 'global:c'])
  })

  it('非数组 / 缺 data 时返回空目录（不抛错）', () => {
    expect(mapModelCatalog(undefined, 'strip-cn')).toEqual([])
    expect(mapModelCatalog({}, 'strip-cn')).toEqual([])
    expect(mapModelCatalog({ data: 'nope' }, 'strip-cn')).toEqual([])
    expect(mapModelCatalog(null, 'strip-cn')).toEqual([])
  })

  it('跳过非法条目', () => {
    const catalog = mapModelCatalog({ data: [{ id: 'cn:a' }, {}, { id: 5 }, { id: 'cn:b' }] }, 'strip-cn')
    expect(catalog.map(model => model.id)).toEqual(['a', 'b'])
  })

  it('strip-cn 下 CN 与 global 同名模型不会撞 id（global 保留前缀）', () => {
    // 实测：global:hy3 的 context_length 被网关硬编码为 131072 且无 max_output_tokens，
    // 而 cn:hy3 有真实窗口与输出上限。两者 id 不同，各自成条、互不覆盖 ——
    // 这正是 strip-cn 必须保留 global: 前缀的原因。
    const catalog = mapModelCatalog({
      data: [
        { id: 'cn:hy3', context_length: 192000, max_output_tokens: 64000, supports_images: true },
        { id: 'global:hy3', context_length: 131072 },
      ],
    }, 'strip-cn')
    expect(catalog.map(model => model.id)).toEqual(['hy3', 'global:hy3'])
    expect(catalog[0]?.contextWindow).toBe(192000)
    expect(catalog[0]?.maxOutputTokens).toBe(64000)
    expect(catalog[1]?.contextWindow).toBe(131072)
  })

  it('同一 id 重复出现时保留信息更完整的那条', () => {
    const catalog = mapModelCatalog({
      data: [
        { id: 'cn:hy3', context_length: 192000, max_output_tokens: 64000 },
        { id: 'cn:hy3', context_length: 131072 },
      ],
    }, 'strip-cn')
    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.contextWindow).toBe(192000)
    expect(catalog[0]?.maxOutputTokens).toBe(64000)
  })

  it('已有完整元数据时不被后续贫瘠条目覆盖', () => {
    const catalog = mapModelCatalog({
      data: [
        { id: 'cn:hy3', context_length: 192000, max_output_tokens: 64000 },
        { id: 'cn:hy3', context_length: 999 },
      ],
    }, 'strip-cn')
    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.contextWindow).toBe(192000)
  })

  it('keep 策略下两个 realm 各自保留', () => {
    const catalog = mapModelCatalog({
      data: [{ id: 'cn:hy3', context_length: 192000 }, { id: 'global:hy3', context_length: 131072 }],
    }, 'keep')
    expect(catalog.map(model => model.id)).toEqual(['cn:hy3', 'global:hy3'])
  })
})

describe('ModelCatalog', () => {
  const entry = (id: string) => ({ id: `cn:${id}` })

  it('命中缓存时不重复请求', async () => {
    let calls = 0
    let clock = 0
    const catalog = new ModelCatalog({
      ttlMs: 1000,
      now: () => clock,
      fetchCatalog: async () => { calls += 1; return mapModelCatalog({ data: [entry('a')] }, 'strip-cn') },
    })
    await catalog.get()
    clock = 500
    await catalog.get()
    expect(calls).toBe(1)
  })

  it('TTL 过期后重新请求', async () => {
    let calls = 0
    let clock = 0
    const catalog = new ModelCatalog({
      ttlMs: 1000,
      now: () => clock,
      fetchCatalog: async () => { calls += 1; return mapModelCatalog({ data: [entry('a')] }, 'strip-cn') },
    })
    await catalog.get()
    clock = 1001
    await catalog.get()
    expect(calls).toBe(2)
  })

  it('并发调用只触发一次上游请求', async () => {
    let calls = 0
    const catalog = new ModelCatalog({
      ttlMs: 1000,
      fetchCatalog: async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 10))
        return mapModelCatalog({ data: [entry('a')] }, 'strip-cn')
      },
    })
    await Promise.all([catalog.get(), catalog.get(), catalog.get()])
    expect(calls).toBe(1)
  })

  it('上游失败时回退旧缓存并记录错误', async () => {
    let fail = false
    const catalog = new ModelCatalog({
      ttlMs: 0,
      fetchCatalog: async () => {
        if (fail) throw new Error('boom')
        return mapModelCatalog({ data: [entry('a')] }, 'strip-cn')
      },
    })
    await catalog.get()
    fail = true
    const models = await catalog.get(true)
    expect(models.map(model => model.id)).toEqual(['a'])
    expect(catalog.lastError).toBe('boom')
  })

  it('上游失败且无旧缓存时返回空数组', async () => {
    const catalog = new ModelCatalog({
      ttlMs: 0,
      fetchCatalog: async () => { throw new Error('boom') },
    })
    expect(await catalog.get()).toEqual([])
    expect(catalog.lastError).toBe('boom')
  })

  it('find 按暴露 id 精确查找', async () => {
    const catalog = new ModelCatalog({
      ttlMs: 1000,
      fetchCatalog: async () => mapModelCatalog({ data: [entry('a'), entry('b')] }, 'strip-cn'),
    })
    expect((await catalog.find('b'))?.bareId).toBe('b')
    expect(await catalog.find('zzz')).toBeUndefined()
  })
})

describe('resolveConfig', () => {
  it('空配置回落到默认值', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('部分字段覆盖、其余保留默认', () => {
    const config = resolveConfig({ baseURL: 'http://127.0.0.1:9999/v1' })
    expect(config.baseURL).toBe('http://127.0.0.1:9999/v1')
    expect(config.listenPort).toBe(DEFAULT_CONFIG.listenPort)
  })

  it('env 是合并而不是整体覆盖', () => {
    const config = resolveConfig({ env: { FOO: 'bar' } })
    expect(config.env).toEqual({ FOO: 'bar' })
  })

  it('非法 realmPrefixPolicy 回退 strip-cn', () => {
    expect(resolveConfig({ realmPrefixPolicy: 'bogus' as never }).realmPrefixPolicy).toBe('strip-cn')
    expect(resolveConfig({ realmPrefixPolicy: 'keep' }).realmPrefixPolicy).toBe('keep')
  })

  it('非法端口回退默认值', () => {
    expect(resolveConfig({ listenPort: 0 }).listenPort).toBe(DEFAULT_CONFIG.listenPort)
    expect(resolveConfig({ listenPort: -1 }).listenPort).toBe(DEFAULT_CONFIG.listenPort)
    expect(resolveConfig({ listenPort: Number.NaN }).listenPort).toBe(DEFAULT_CONFIG.listenPort)
  })
})

describe('gatewayOrigin / gatewayPort', () => {
  it('剥掉结尾的 /v1', () => {
    expect(gatewayOrigin('http://127.0.0.1:7863/v1')).toBe('http://127.0.0.1:7863')
    expect(gatewayOrigin('http://127.0.0.1:7863/v1/')).toBe('http://127.0.0.1:7863')
  })

  it('无 /v1 时原样返回', () => {
    expect(gatewayOrigin('http://127.0.0.1:7863')).toBe('http://127.0.0.1:7863')
  })

  it('从 URL 取端口，解析失败时回退', () => {
    expect(gatewayPort('http://127.0.0.1:7863/v1', 1)).toBe(7863)
    expect(gatewayPort('http://127.0.0.1/v1', 42)).toBe(80)
    expect(gatewayPort('https://example.com/v1', 42)).toBe(443)
    expect(gatewayPort('not a url', 42)).toBe(42)
  })
})
