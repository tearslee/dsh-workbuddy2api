# 轮级聚合：让一次对话只有一个 RequestID

> 本文是 [dsh-workbuddy2api](../README.md) 的背景说明，解释两件事：上游
> RequestID 碎片化问题是怎么修的，以及插件为什么必须按现在这种方式序列化消息。

## 问题长什么样

如果你曾在 [腾讯 CodeBuddy 后台用量明细](https://www.codebuddy.cn/admin/usage/detail) 里看到**一次对话被拆成几十上百条记录**，那就是上游的 RequestID 碎片化。

正常直连 CodeBuddy 时，一次对话只产生 **1 个** RequestID；经网关转发后却变成几十上百个。这是同一个问题在三个阶段的实测截图：

**① 修复前** —— 上游后台把一次对话拆成无数次小请求

<img src="https://raw.githubusercontent.com/tearslee/dsh-workbuddy2api/main/docs/images/before-fragmented.png" alt="修复前：同一请求在上游后台被拆分为几十上百个 RequestID" width="100%">

**② 上游第一次修复后** —— 加了会话头族，**但仍然是多个请求**（因为 OpenAI 兼容客户端不带 `conversationId`）

<img src="https://raw.githubusercontent.com/tearslee/dsh-workbuddy2api/main/docs/images/after-upstream-fix-still-fragmented.png" alt="上游第一次修复后仍然碎片化" width="100%">

**③ PR #73 合并后** —— 按对话轮聚合，一次对话轮一个 RequestID

<img src="https://raw.githubusercontent.com/tearslee/dsh-workbuddy2api/main/docs/images/after-pr-fixed-1.png" alt="修复后：RequestID 按对话轮聚合" width="100%">

<img src="https://raw.githubusercontent.com/tearslee/dsh-workbuddy2api/main/docs/images/after-pr-fixed-2.png" alt="修复后：用量明细按轮聚合" width="100%">

（截图取自上游 issue [#35](https://github.com/Sliverkiss/workbuddy2api/issues/35) 与 [#69](https://github.com/Sliverkiss/workbuddy2api/issues/69)。）

## 这个 bug 是怎么修的

1. **上游先加会话头族**（`X-Conversation-ID` / `X-Conversation-Request-ID` / `X-Request-ID` / B3 trace 族），后台改按 `X-Conversation-Request-ID` 聚合。
2. **但没修好** —— 因为 OpenAI 兼容客户端（dsh / Codex / Cherry Studio）的请求体里**既无 `conversationId` 也无 `metadata`**，网关的 `ExtractKey` 恒返回空串，聚合主键只能逐请求新生成。当时的截图（issue #69 里回复「更新后我发现其实还是多个请求」）：见上方 **②**。
3. **本仓库作者提交的 [PR #73](https://github.com/Sliverkiss/workbuddy2api/pull/73)（已合并）** 补上了缺失的那一层：为**无会话键客户端**增加「对话轮级」兜底聚合键：

   ```
   TurnKey(body) = body 里最后一条 role=="user" 消息的「序号:文本」
   TurnRequestID(turnKey) = sha256(盐|turnKey) 前 16 字节 hex
   ```

   取**最后一条**而非第一条：首条在整个会话内不变，会把一次会话的所有轮并成一个键；序号入键：两轮里内容相同的提问（"继续"）不会被混并。于是**一次用户发送内的所有上游调用**（tool call 多轮 / 换号重试 / 降级重发）共享同一个 ID，用户发下一条消息自动换键。

   > 上游随后在 `edfbf06` 里把会话级与轮级的派生收敛到同一个盐，消除了重复实现。
   > 该实现至今未变（核对基线：上游 `master` @ `a9ccace`，见
   > `internal/session/ids.go` 的 `TurnKey` / `TurnRequestID`）。

## 为什么插件必须知道这件事

**它是关键的一环。** `TurnKey` 的输入是**适配器实际发出去的请求体**。它的规则是「最后一条 `role=="user"` 消息」，于是插件侧有两条隐含前提，一旦破坏就会让碎片化**静默复发**（网关照常回包，只有腾讯后台的用量明细能看出问题）：

| 前提 | 为什么 | 插件怎么做 |
|---|---|---|
| 工具结果**不能**以 `role:"user"` 上线 | harness 把 tool-result 搭载在 **user 角色**消息里。若原样发出，`TurnKey` 会取到「工具输出」那条（每轮都变）→ 键每轮漂移 → 碎片化复发 | 展开为独立的 `role:"tool"` 消息，于是「最后一条 user」仍是用户真正的那句话 |
| 末条用户文本在轮内**逐字不变** | 轮内会不断追加 assistant/tool 消息；若用户那句话被改写或挪位，同轮各 step 会各拿一个键 | 序列化时不动用户消息的内容与顺序 |

这两条都在 `tests/unit/turn-key-contract.spec.ts` 里用**与 Go 侧同构的取键规则**做了断言（跨语言契约测试），并且验证过：把 `role:'tool'` 改回 `role:'user'` 会让 8 个测试立刻失败。

> 换句话说：**PR #73 修的是网关侧「没有键」的问题；本插件保证那个键在 dsh 这条链路上真的稳定。**

## 端到端证据

`tools/turnkey-verify/` 把适配器**真实产出的请求体**喂给**上游真实的 Go 实现**跑一遍，
得到端到端证据 —— 一次对话轮内三个 step 派生出**完全相同**的聚合 ID：

```
A-step1        key=u0:跑一下        id=9c332f24c59f87d3ac74f9c0a3f824d7
A-step2        key=u0:跑一下        id=9c332f24c59f87d3ac74f9c0a3f824d7
A-step3        key=u0:跑一下        id=9c332f24c59f87d3ac74f9c0a3f824d7
```

（2026-09-17 在网关 `master` @ `a9ccace` 上实测，5/5 通过。`id` 每次运行都不同 ——
派生盐是进程级随机值；可复现的是「三行逐字相同」。）

跑法与判据见 [tools/turnkey-verify/README.md](../tools/turnkey-verify/README.md)。
