/**
 * SSE 流读取与工具参数归一化的共享工具。
 *
 * 与 codearts 的两个适配器面临同类后端行为：网关在连接空闲一段时间后会静默
 * 掐断，或模型在生成大工具参数期间长时间不 flush 任何字节。若不主动检测空闲，
 * `reader.read()` 会无限期挂起 —— 适配器的 generator 永不返回，当前步骤既不出
 * 结果也不报错。主动超时并把失败归类为可重试的 `TIMEOUT`，dsh 才能重试该步骤。
 *
 * @module dsh-workbuddy2api/sse
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** SSE 读取阶段：等待首 token 与已收到数据后的 chunk 间等待。 */
export type SsePhase = 'first-token' | 'chunk'

/**
 * 在空闲超时内读取一个流块。超过 `timeoutMs` 无数据则取消 reader 并抛可重试的
 * `LlmError('TIMEOUT')` —— 比被动等待网关掐断更早失败，且归类为可重试 code。
 * 尊重调用方传入的 `signal`：已 abort 时直接抛其 reason，不误报超时。
 *
 * **必须让 abort 也终结这次等待**：只清掉定时器是不够的 —— `reader.read()` 在连接
 * 半开时本就不 settle，清掉定时器会让 `Promise.race` 永远悬空，generator 既不产出
 * 也不返回。这正是本文件开头警告的失效模式，因此 abort 分支同样 reject。
 *
 * @param reader - `response.body` 的 reader。
 * @param timeoutMs - 空闲上限（毫秒）。
 * @param label - 错误消息前缀。
 * @param signal - 调用方取消信号。
 * @param phase - 仅用于错误消息区分首 token 超时与 chunk 间超时。
 * @returns 本次读取结果。
 */
export async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  phase: SsePhase = 'chunk',
): Promise<{ done: boolean; value: Uint8Array | undefined }> {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onUserAbort: (() => void) | undefined
  const readPromise = reader.read()
  // 竞速的对手：超时或 abort 任一先到即终结等待。
  const interrupt = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new LlmError(`${label}: sse ${phase} timeout after ${timeoutMs}ms`, 'TIMEOUT')) }, timeoutMs)
    onUserAbort = () => { reject(signal?.reason ?? new Error('aborted')) }
    signal?.addEventListener('abort', onUserAbort, { once: true })
  })
  try {
    const result = await Promise.race([readPromise, interrupt])
    return { done: result.done, value: result.value }
  } catch (error) {
    // 用户取消：透传原因（连接交给 fetch 的 signal 收尾）。
    if (signal?.aborted) throw signal.reason ?? error
    // 空闲超时：取消 reader 释放底层连接，再抛可重试 TIMEOUT。
    if (error instanceof LlmError) {
      await reader.cancel().catch(() => {})
      throw error
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (onUserAbort !== undefined) signal?.removeEventListener('abort', onUserAbort)
  }
}

/**
 * 剔除无法配对的工具调用与工具结果。
 *
 * OpenAI 兼容协议要求：带 `tool_calls` 的 assistant 消息，其**每一个** tool_call id
 * 都必须紧跟一条对应的 `role:'tool'` 结果消息；反之亦然。缺任一侧后端都会以 400
 * 拒绝整个请求。
 *
 * 工具执行失败时（参数非法、超时、工具不存在……）harness 会把 assistant 的
 * tool_calls 持久化进会话历史，却写不回结果消息。这条坏历史随后被每次请求原样
 * 重放，于是后端对之后每一条用户消息都返回 400 —— 表现为「任务突然中断，此后
 * 发送任何内容都没有回复」，整个会话彻底报废。
 *
 * 适配器是最后一道防线：发出请求前剔除无法配对的条目让会话自愈。宁可丢失一轮
 * 工具上下文，也好过整条会话死亡。
 *
 * @param messages - harness 会话消息（按时间顺序）。
 * @returns 应当保留的 tool_call id 与 tool 结果 id 集合。
 */
export function resolveToolPairing(
  messages: readonly { role: string; content: unknown }[],
): { keepCallIds: Set<string>; keepResultIds: Set<string> } {
  // 收集历史上出现过的所有工具结果 id（harness 把结果搭载在 user 消息里）。
  const allResultIds = new Set<string>()
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result') {
        allResultIds.add(String((block as { toolCallId?: unknown }).toolCallId))
      }
    }
  }
  // 一批 tool_calls 只有全部拿到结果才能保留：部分保留会留下无结果的 tool_call，
  // 后端照样拒绝。
  const keepCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const content = Array.isArray(message.content) ? message.content : []
    const calls = content.filter((block): block is { type: string; id: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
    if (calls.length === 0) continue
    if (calls.every(block => allResultIds.has(String(block.id)))) {
      for (const block of calls) keepCallIds.add(String(block.id))
    }
  }
  // 结果消息只有在对应 tool_call 被保留时才保留。
  const keepResultIds = new Set<string>()
  for (const id of keepCallIds) {
    if (allResultIds.has(id)) keepResultIds.add(id)
  }
  return { keepCallIds, keepResultIds }
}

/**
 * 把工具调用的 arguments 文本归一化为合法的 JSON 对象字面量。
 *
 * 后端在两种情况下会给出非对象的 arguments：
 * - 无参数工具只下发一个空分片（`"arguments":""`），拼接结果为空串；
 * - SSE 流被截断，只收到半截 JSON。
 *
 * 两者都会让 harness 解析参数时报
 * `invalid arguments: "arguments" must be an object`。归一化为 `{}` 后，缺少必填
 * 参数的工具会走正常的 schema 校验错误并回传给模型，而不是让整个会话崩溃。
 *
 * @param raw - 拼接后的 arguments 文本。
 * @returns 合法 JSON 对象文本，或 `{}`。
 */
export function normalizeToolArguments(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return '{}'
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // 不完整的 JSON（流被截断）：回退为空对象。
    return '{}'
  }
  // OpenAI 规范要求 arguments 是对象；null / 数组 / 标量都不是合法参数包。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}'
  return trimmed
}

/**
 * 判断工具参数是否因分片丢失而残缺（区别于「该工具本就无参数」）。
 *
 * - **空串**：无参数工具只下发一个空分片，这是**合法**的，补 `{}` 即可；
 * - **非空但无法解析**：说明参数分片在流式下发中丢了。绝不能补成 `{}` 了事 ——
 *   那等于伪造一个「看起来合法」的调用，harness 执行时报
 *   `missing required property ...`，真正的病因（分片丢失）被掩盖。
 *   正确做法是判定为截断并报告 max-tokens，让 dsh 丢弃残缺调用并重试。
 *
 * 只把**无法解析**视为截断。能解析但类型不对（标量、数组）属于模型输出有误，
 * 交给 schema 校验回传即可，不应触发重试。
 *
 * @param raw - 拼接后的 arguments 文本。
 * @returns 是否残缺。
 */
export function isTruncatedArguments(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return false
  try {
    JSON.parse(trimmed)
    return false
  } catch {
    return true
  }
}
