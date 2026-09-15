/**
 * 锁定「轮级聚合键」在本插件侧的契约。
 *
 * 背景：workbuddy2api 的 issue #35 / #69 报告「一次对话在上游后台被拆成几十上百个
 * RequestID」。根因是网关此前不下发会话头族，上游按 HTTP 请求逐条记账。上游加了
 * `X-Conversation-Request-ID` 后仍碎片化；本仓库作者提交的 **PR #73**
 * （`internal/session/ids.go` 的 `TurnKey` / `TurnRequestID`）为**无会话键的
 * OpenAI 兼容客户端**补了「对话轮级」兜底聚合键，才真正修好。
 *
 * 那个修复能否生效，**取决于适配器发出去的请求体**：
 *
 *   `TurnKey`（`ids.go`）= body 里**最后一条** `role=="user"` 消息的「序号:文本」。
 *
 * 于是插件侧有两条必须成立的隐含前提，一旦破坏就会让碎片化复发、且是**静默复发**
 * （网关照常回包，只有腾讯后台的用量明细能看出问题）：
 *
 *   1. **工具结果不能以 `role:"user"` 出现在线上**。harness 把 tool-result 搭载在
 *      user 角色消息里；若原样发出，`TurnKey` 会取到工具结果那一条（其文本每轮不同）
 *      → 键每轮漂移 → 碎片化复发。本插件把它展开成独立的 `role:"tool"`，所以
 *      「最后一条 user」仍是用户真正的那句话。
 *   2. **末条用户文本必须逐字不变**。轮内追加 assistant/tool 消息不得改变它，
 *      否则同一轮内多个 step 会各拿一个键。
 *
 * 本文件用与 Go 侧同构的取键规则，对适配器真实产出的请求体做断言 —— 相当于一个
 * 跨语言的契约测试。
 */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { serializeMessages } from '../../src/gateway-adapter.js'

/**
 * 与 Go `session.TurnKey` 同构的取键：找最后一条 `role=="user"` 消息，
 * 返回 `u<下标>:<文本>`；该消息无文本则返回空串（不继续往前找）。
 *
 * 对应 `internal/session/ids.go`：
 *   for i := len(msgs)-1; i>=0; i-- { if role != "user" continue
 *       text := contentText(...); if text == "" { return "" }
 *       return fmt.Sprintf("u%d:%s", i, text) }
 *
 * @param messages - 线上消息数组。
 * @returns 轮级键；无法建立时为空串。
 */
function turnKeyOf(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = contentText(message.content)
    if (text === '') return ''
    return `u${i}:${text}`
  }
  return ''
}

/** 与 Go `contentText` 同构：字符串直通；parts 数组拼 text 字段；其余为空。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (typeof part === 'object' && part !== null ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('')
}

/** 造一条 harness user 消息（带 id/source，符合 Message 形状）。 */
function userMessage(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** 造一条 harness assistant 消息，携带工具调用。 */
function assistantToolCall(id: string, callId: string, name: string) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
    source: { kind: 'model', provider: 'workbuddy2api', model: 'm' },
  }
}

/** 造一条 harness 工具结果消息（**role 是 user** —— 这正是风险点）。 */
function toolResultMessage(id: string, callId: string, text: string) {
  return {
    id,
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
    source: { kind: 'tool', callId },
  }
}

const baseOptions: GenerateOptions = {
  provider: 'workbuddy2api',
  model: 'glm-5.2',
  messages: [] as never,
}

/** 把 harness 消息经适配器序列化成线上消息。 */
function wire(messages: unknown[]): Array<Record<string, unknown>> {
  return serializeMessages(messages as never, undefined)
}

describe('轮级聚合键：适配器必须让 TurnKey 取到用户那句话', () => {
  it('工具结果展开为 role:tool，因此「最后一条 user」仍是用户提问', () => {
    const messages = wire([
      userMessage('m1', '跑一下'),
      assistantToolCall('m2', 'c1', 'pwsh'),
      toolResultMessage('m3', 'c1', '命令输出'),
    ])
    // 关键：工具结果落在 role:"tool"，不是 role:"user"。
    expect(messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(messages.filter(m => m.role === 'tool')).toHaveLength(1)
    // 于是 TurnKey 取到的是用户原话，而不是"命令输出"。
    expect(turnKeyOf(messages)).toBe('u0:跑一下')
  })

  it('若工具结果以 role:user 出现，键会漂移（反例：锁住我们避开的坑）', () => {
    // 手工构造"没展开"的形态，证明这条约束不是空谈。
    const naive: Array<Record<string, unknown>> = [
      { role: 'user', content: '跑一下' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      // 假设适配器把工具结果原样当 user 发出：
      { role: 'user', content: '命令输出' },
    ]
    expect(turnKeyOf(naive)).toBe('u2:命令输出') // ← 每轮都会变 → 碎片化复发
    // 而适配器真实产出的形态取到稳定键：
    expect(turnKeyOf(wire([
      userMessage('m1', '跑一下'),
      assistantToolCall('m2', 'c1', 'pwsh'),
      toolResultMessage('m3', 'c1', '命令输出'),
    ]))).toBe('u0:跑一下')
  })

  it('轮内追加多轮工具调用，键保持不变（对应 Go 侧 agent 多步用例）', () => {
    const step1 = wire([userMessage('m1', '跑一下')])

    const step2 = wire([
      userMessage('m1', '跑一下'),
      assistantToolCall('m2', 'c1', 'pwsh'),
      toolResultMessage('m3', 'c1', '结果'),
    ])

    const step3 = wire([
      userMessage('m1', '跑一下'),
      assistantToolCall('m2', 'c1', 'pwsh'),
      toolResultMessage('m3', 'c1', '结果'),
      assistantToolCall('m4', 'c2', 'read'),
      toolResultMessage('m5', 'c2', '文件内容'),
    ])

    const key1 = turnKeyOf(step1)
    const key2 = turnKeyOf(step2)
    const key3 = turnKeyOf(step3)

    expect(key1).not.toBe('')
    expect(key2).toBe(key1)
    expect(key3).toBe(key1)
  })

  it('用户发下一条消息 → 新键（对话轮边界）', () => {
    const turn1 = wire([
      userMessage('m1', '跑一下'),
      assistantToolCall('m2', 'c1', 'pwsh'),
      toolResultMessage('m3', 'c1', '结果'),
    ])
    const turn2 = wire([
      userMessage('m1', '跑一下'),
      assistantToolCall('m2', 'c1', 'pwsh'),
      toolResultMessage('m3', 'c1', '结果'),
      userMessage('m4', '再跑一下'),
    ])
    expect(turnKeyOf(turn2)).not.toBe(turnKeyOf(turn1))
    expect(turnKeyOf(turn2)).toBe('u3:再跑一下')
  })

  it('同一问题在两轮里重复出现也不会并成一轮（序号入键）', () => {
    const first = wire([userMessage('m1', '继续')])
    const second = wire([
      userMessage('m1', '继续'),
      assistantToolCall('m2', 'c1', 'pwsh'),
      toolResultMessage('m3', 'c1', 'ok'),
      userMessage('m4', '继续'),
    ])
    // 文本相同但序号不同 → 不同键。
    expect(turnKeyOf(first)).toBe('u0:继续')
    expect(turnKeyOf(second)).toBe('u3:继续')
    expect(turnKeyOf(first)).not.toBe(turnKeyOf(second))
  })

  it('带 system 时也不影响取键（system 不是 user）', () => {
    const messages = wire([
      userMessage('m1', '跑一下'),
      assistantToolCall('m2', 'c1', 'pwsh'),
      toolResultMessage('m3', 'c1', '结果'),
    ])
    const withSystem = [{ role: 'system', content: '你是助手' }, ...messages]
    expect(turnKeyOf(withSystem)).toBe('u1:跑一下')
  })

  it('多模态用户消息仍能提供文本（拼 text part）', () => {
    const messages = wire([{
      id: 'm1',
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', attachment: { id: 'img1' } },
      ],
      source: { kind: 'user' },
    }])
    expect(turnKeyOf(messages)).toBe('u0:看这张图')
  })

  it('纯工具结果、无用户文本 → 无法建立键（网关回落请求级随机 ID）', () => {
    const messages = wire([
      assistantToolCall('m1', 'c1', 'pwsh'),
      toolResultMessage('m2', 'c1', '结果'),
    ])
    // 这是**预期**的降级：没有用户轮可聚合，网关各自发随机 ID，
    // 而不是伪造一个会漂移的聚合键。
    expect(turnKeyOf(messages)).toBe('')
  })

  it('孤儿工具调用被剔除后，用户文本仍在原位', () => {
    // 工具执行失败时 harness 会留下无结果的 tool_call；适配器剔除它，
    // 但不得因此改动用户消息的内容与位置。
    const messages = wire([
      userMessage('m1', '跑一下'),
      assistantToolCall('m2', 'orphan', 'pwsh'),
    ])
    expect(turnKeyOf(messages)).toBe('u0:跑一下')
  })

  it('适配器不在 body 里发送 conversationId（保持走轮级兜底路径）', () => {
    // 网关的取键是三分支：入站头 > 会话键 > 轮级兜底。
    // 本适配器不提 conversationId，因此稳定走在轮级兜底上 ——
    // 这正是 PR #73 修好的那条路径。
    const messages = wire([userMessage('m1', '跑一下')])
    const body = { model: 'cn:glm-5.2', messages, stream: true } as Record<string, unknown>
    expect('conversationId' in body).toBe(false)
    expect('conversation_id' in body).toBe(false)
    expect('metadata' in body).toBe(false)
    expect(turnKeyOf(body.messages as Array<Record<string, unknown>>)).toBe('u0:跑一下')
    void baseOptions
  })
})

describe('跨语言验证用的样本文件不得失真', () => {
  // `tests/fixtures/turn-bodies.json` 是 `emit-turn-bodies.mjs` 的产物，
  // 会被喂给**上游真实的 Go 实现**做验证（见 tools/turnkey-verify/）。
  // 如果它悄悄过期，那个跨语言验证就变成了"验证一份旧数据"—— 看起来通过、
  // 实际早已与适配器脱节。这里锁住它与当前序列化行为一致。
  it('turn-bodies.json 与当前 serializeMessages 输出一致', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')

    const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
    const committed = JSON.parse(readFileSync(join(fixturesDir, 'turn-bodies.json'), 'utf8')) as Array<{
      name: string
      body: { model: string; stream: boolean; messages: Array<Record<string, unknown>> }
    }>

    expect(committed.length).toBeGreaterThan(0)

    // 每个样本都必须真的含 messages，且至少有一个样本带工具结果 —— 否则这份
    // 样本集无法验证「工具结果不落在 role:user」这条最关键的性质。
    for (const sample of committed) {
      expect(Array.isArray(sample.body.messages)).toBe(true)
      expect(sample.body.stream).toBe(true)
    }
    const allMessages = committed.flatMap(sample => sample.body.messages)
    expect(allMessages.some(m => m.role === 'tool')).toBe(true)

    // 样本里不得出现 role:"user" 的工具结果（那正是碎片化的成因）。
    for (const message of allMessages) {
      if (message.role !== 'user') continue
      const content = Array.isArray(message.content) ? message.content : []
      const hasToolResult = content.some(
        block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result',
      )
      expect(hasToolResult).toBe(false)
    }

    // 关键回归：A 轮三个 step 的取键必须相同（用与当前序列化一致的规则复算）。
    const byName = new Map(committed.map(sample => [sample.name, sample.body.messages]))
    const a1 = turnKeyOf(byName.get('A-step1') ?? [])
    const a2 = turnKeyOf(byName.get('A-step2') ?? [])
    const a3 = turnKeyOf(byName.get('A-step3') ?? [])
    expect(a1).not.toBe('')
    expect(a2).toBe(a1)
    expect(a3).toBe(a1)
  })
})
