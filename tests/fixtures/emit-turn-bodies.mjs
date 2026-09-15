/**
 * 生成「适配器真实产出的请求体」样本，交给 Go 侧真实实现验证轮级键。
 *
 * 用法：node tests/fixtures/emit-turn-bodies.mjs > tests/fixtures/turn-bodies.json
 *
 * 为什么需要它：`tests/unit/turn-key-contract.spec.ts` 里的取键函数是我**按 Go 源码
 * 同构重写**的 —— 它只能证明「我理解的规则自洽」，不能证明「这就是网关真正在跑的逻辑」。
 * 把这里导出的请求体喂给 `internal/session.TurnKey` 真跑一遍，才能证明这条链路
 * 端到端成立。
 *
 * 注意：这里复用构建产物 `lib/gateway-adapter.js`（而非 src），
 * 保证验证对象就是实际发布的代码。
 */

import { serializeMessages } from '../../lib/gateway-adapter.js'

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const asst = (id, callId, name) => ({
  id, role: 'assistant',
  content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
  source: { kind: 'model', provider: 'workbuddy2api', model: 'glm-5.2' },
})
const tool = (id, callId, text) => ({
  id, role: 'user',
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
  source: { kind: 'tool', callId },
})

/** 一次「用户提问 → 两轮工具调用」的完整对话轮。 */
const turnA = [
  { name: 'A-step1', messages: [user('m1', '跑一下')] },
  {
    name: 'A-step2',
    messages: [user('m1', '跑一下'), asst('m2', 'c1', 'pwsh'), tool('m3', 'c1', '结果一')],
  },
  {
    name: 'A-step3',
    // 关键：工具输出每步都不同。若适配器把 tool-result 发成 role:user，键就会漂移。
    messages: [
      user('m1', '跑一下'), asst('m2', 'c1', 'pwsh'), tool('m3', 'c1', '结果一'),
      asst('m4', 'c2', 'read'), tool('m5', 'c2', '结果二-和上一次不同'),
    ],
  },
]

/** 第二个对话轮：用户又说了句话。 */
const turnB = [
  {
    name: 'B-step1',
    messages: [
      user('m1', '跑一下'), asst('m2', 'c1', 'pwsh'), tool('m3', 'c1', '结果一'),
      asst('m4', 'c2', 'read'), tool('m5', 'c2', '结果二-和上一次不同'),
      user('m6', '再跑一下'),
    ],
  },
]

/** 第三个轮：与 A 轮文本完全相同，但发生在不同位置 —— 序号入键应使其不同。 */
const turnC = [
  {
    name: 'C-step1',
    messages: [
      user('m1', '跑一下'), asst('m2', 'c1', 'pwsh'), tool('m3', 'c1', '结果一'),
      asst('m4', 'c2', 'read'), tool('m5', 'c2', '结果二-和上一次不同'),
      user('m6', '再跑一下'), asst('m7', 'c3', 'pwsh'), tool('m8', 'c3', 'ok'),
      user('m9', '跑一下'),
    ],
  },
]

/** 多模态用户消息：parts 形态，Go 侧 contentText 需拼出 text。 */
const multimodal = [
  {
    name: 'D-multimodal',
    messages: [{
      id: 'm1', role: 'user',
      content: [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: { id: 'img1' } }],
      source: { kind: 'user' },
    }],
  },
]

/** 无用户文本（纯工具结果）：应无法建立键。 */
const noUserText = [
  { name: 'E-no-user', messages: [asst('m1', 'c1', 'pwsh'), tool('m2', 'c1', '结果')] },
]

const cases = [...turnA, ...turnB, ...turnC, ...multimodal, ...noUserText]

const out = cases.map(({ name, messages }) => ({
  name,
  body: { model: 'cn:glm-5.2', stream: true, messages: serializeMessages(messages, undefined) },
}))

process.stdout.write(JSON.stringify(out, null, 2) + '\n')
