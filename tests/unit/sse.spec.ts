import { describe, expect, it } from 'vitest'
import {
  isTruncatedArguments,
  normalizeToolArguments,
  readWithIdleTimeout,
  resolveToolPairing,
} from '../../src/sse.js'

describe('normalizeToolArguments', () => {
  it('空串补成 {}（无参数工具的合法形态）', () => {
    expect(normalizeToolArguments('')).toBe('{}')
    expect(normalizeToolArguments('   ')).toBe('{}')
  })

  it('合法对象原样保留（含首尾空白）', () => {
    expect(normalizeToolArguments('{"a":1}')).toBe('{"a":1}')
    expect(normalizeToolArguments(' {"a":1} ')).toBe('{"a":1}')
  })

  it('残缺 JSON 回退为 {}', () => {
    expect(normalizeToolArguments('{"a":')).toBe('{}')
    expect(normalizeToolArguments('{"file_path": "…')).toBe('{}')
  })

  it('非对象字面量回退为 {}', () => {
    expect(normalizeToolArguments('null')).toBe('{}')
    expect(normalizeToolArguments('[1,2]')).toBe('{}')
    expect(normalizeToolArguments('42')).toBe('{}')
    expect(normalizeToolArguments('"str"')).toBe('{}')
  })
})

describe('isTruncatedArguments', () => {
  it('空串不算截断（无参数工具本就如此）', () => {
    expect(isTruncatedArguments('')).toBe(false)
    expect(isTruncatedArguments('  ')).toBe(false)
  })

  it('可解析即不算截断', () => {
    expect(isTruncatedArguments('{}')).toBe(false)
    expect(isTruncatedArguments('{"a":1}')).toBe(false)
    // 类型不对属于模型输出有误，交给 schema 校验，不触发重试。
    expect(isTruncatedArguments('[1,2]')).toBe(false)
    expect(isTruncatedArguments('42')).toBe(false)
  })

  it('无法解析即截断（分片丢失）', () => {
    expect(isTruncatedArguments('{"a":')).toBe(true)
    expect(isTruncatedArguments('{"file_path": "…')).toBe(true)
    expect(isTruncatedArguments('}')).toBe(true)
  })
})

describe('resolveToolPairing', () => {
  const call = (id: string) => ({ type: 'tool-call', id, name: 'read', arguments: '{}' })
  const result = (id: string) => ({ type: 'tool-result', toolCallId: id, content: [] })

  it('配对完整时全部保留', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [call('a'), call('b')] },
      { role: 'user', content: [result('a'), result('b')] },
    ])
    expect([...keepCallIds].sort()).toEqual(['a', 'b'])
    expect([...keepResultIds].sort()).toEqual(['a', 'b'])
  })

  it('一批 tool_calls 只有全部有结果才保留（部分保留仍会被后端 400）', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [call('a'), call('b')] },
      { role: 'user', content: [result('a')] },
    ])
    expect([...keepCallIds]).toEqual([])
    expect([...keepResultIds]).toEqual([])
  })

  it('孤儿 tool_call（无结果）被剔除', () => {
    const { keepCallIds } = resolveToolPairing([
      { role: 'assistant', content: [call('orphan')] },
      { role: 'user', content: [] },
    ])
    expect([...keepCallIds]).toEqual([])
  })

  it('孤儿 tool-result（无对应调用）被剔除', () => {
    const { keepResultIds } = resolveToolPairing([
      { role: 'user', content: [result('ghost')] },
    ])
    expect([...keepResultIds]).toEqual([])
  })

  it('多轮历史的配对互不干扰', () => {
    const { keepCallIds } = resolveToolPairing([
      { role: 'assistant', content: [call('a')] },
      { role: 'user', content: [result('a')] },
      { role: 'assistant', content: [call('b')] },
      { role: 'user', content: [result('b')] },
    ])
    expect([...keepCallIds].sort()).toEqual(['a', 'b'])
  })

  it('无工具调用时返回空集合', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([{ role: 'user', content: 'hello' }])
    expect(keepCallIds.size).toBe(0)
    expect(keepResultIds.size).toBe(0)
  })
})

describe('readWithIdleTimeout', () => {
  /** 构造一个可控的 reader。 */
  function makeReader(behavior: () => Promise<{ done: boolean; value: Uint8Array | undefined }>) {
    let cancelled = false
    return {
      reader: {
        read: behavior,
        cancel: async () => { cancelled = true },
      } as unknown as ReadableStreamDefaultReader<Uint8Array>,
      wasCancelled: () => cancelled,
    }
  }

  it('正常返回数据', async () => {
    const { reader } = makeReader(async () => ({ done: false, value: new Uint8Array([1, 2, 3]) }))
    const result = await readWithIdleTimeout(reader, 1000, 'test')
    expect(result.done).toBe(false)
    expect(result.value).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('超时抛可重试的 TIMEOUT 并取消 reader', async () => {
    const { reader, wasCancelled } = makeReader(() => new Promise(() => {}))
    await expect(readWithIdleTimeout(reader, 20, 'test')).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(wasCancelled()).toBe(true)
  })

  it('超时错误消息区分 first-token 与 chunk 阶段', async () => {
    const { reader } = makeReader(() => new Promise(() => {}))
    await expect(readWithIdleTimeout(reader, 20, 'wb', undefined, 'first-token'))
      .rejects.toThrow(/first-token/)
  })

  it('已 abort 的 signal 直接抛其 reason，不误报超时', async () => {
    const { reader } = makeReader(() => new Promise(() => {}))
    const controller = new AbortController()
    const reason = new Error('user cancelled')
    controller.abort(reason)
    await expect(readWithIdleTimeout(reader, 1000, 'test', controller.signal)).rejects.toThrow('user cancelled')
  })

  it('中途 abort 时透传 reason 而非超时', async () => {
    const { reader } = makeReader(() => new Promise(() => {}))
    const controller = new AbortController()
    const reason = new Error('stop now')
    setTimeout(() => controller.abort(reason), 5)
    await expect(readWithIdleTimeout(reader, 5000, 'test', controller.signal)).rejects.toThrow('stop now')
  })

  it('非超时的底层错误原样抛出', async () => {
    const { reader } = makeReader(async () => { throw new Error('socket died') })
    await expect(readWithIdleTimeout(reader, 1000, 'test')).rejects.toThrow('socket died')
  })
})
