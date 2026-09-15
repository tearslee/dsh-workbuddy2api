# 轮级聚合键的跨语言验证工具

## 它验证什么

上游 [workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) 的 PR #73（本仓库作者提交，
已合并）为**无会话键的 OpenAI 兼容客户端**补了「对话轮级」兜底聚合键，修掉了
issue #35 / #69 的 RequestID 碎片化。见根 README 的「为什么这个插件重要」一节。

那个修复是否生效，取决于**适配器实际发出去的请求体**。本工具把适配器真实产出的
请求体喂给**上游真实的 Go 实现** `session.TurnKey` / `session.TurnRequestID`，
验证一次对话轮内所有 step 派生出同一个聚合 ID。

## 为什么不能只靠 TypeScript 单测

`tests/unit/turn-key-contract.spec.ts` 里的取键函数是**按 Go 源码同构重写**的 ——
它只能证明「我理解的规则自洽」。上游实现一旦变化（比如改成取第一条 user 消息），
那份 TS 副本不会知道。本工具直接链接上游代码，是唯一能发现这种漂移的手段。

## 怎么跑

`internal/` 包按 Go 规则**只能被同一模块内的代码导入**，所以无法从外部模块
`replace` 进来（会报 `use of internal package ... not allowed`）。因此本工具设计成
**一次性拷贝进 clone 里跑**：

```bash
# 1. 生成适配器真实产出的请求体（用构建产物 lib/，所以先构建）
node node_modules/typescript/bin/tsc -p tsconfig.json
node tests/fixtures/emit-turn-bodies.mjs > tests/fixtures/turn-bodies.json

# 2. 拷贝进上游 clone 并运行（跑完即删，不改动上游任何已跟踪文件）
cp -r tools/turnkey-verify/turncheck /path/to/workbuddy2api/internal/session/turncheck
cd /path/to/workbuddy2api
go run ./internal/session/turncheck -bodies /abs/path/to/tests/fixtures/turn-bodies.json

# 3. 清理
rm -rf /path/to/workbuddy2api/internal/session/turncheck
```

放在 `internal/session/` 下是为了让 `workbuddy2api/internal/session` 成为同模块内的
可导入包。跑完请删除 —— 上游仓库不该留下本工具的任何痕迹。

## 通过判据

```
[PASS] A 轮三个 step 同键（轮内 tool call 多轮不换键）
[PASS] B 轮与 A 轮不同键（用户发下一条消息换键）
[PASS] C 轮与 A 轮不同键（同样文本但在不同序号）
[PASS] 多模态用户消息可建键
[PASS] 无用户文本时不建键（不伪造聚合键）
```

最重要的是第一条：A 轮三个 step 的 `id=` 必须**逐字相同** —— 那就是「一次对话轮
在上游后台只记一条」的直接证据。

## 如果它失败了

最可能是这两处之一：

| 症状 | 原因 |
|---|---|
| A 轮 step 之间 id 不同 | 适配器把工具结果发成了 `role:"user"` —— `TurnKey` 会取到工具输出那条，每步都变。`serializeMessages()` 里必须发 `role:"tool"`。 |
| 用户文本对不上 | 序列化动了用户消息的内容或顺序（比如改写了正文、或把 system 插到了 user 之后）。 |

## 实测结果（2026-09-15，master `3b87c14`）

```
A-step1        key=u0:跑一下        id=6a0edaa54b38c3473703e66325edde74
A-step2        key=u0:跑一下        id=6a0edaa54b38c3473703e66325edde74
A-step3        key=u0:跑一下        id=6a0edaa54b38c3473703e66325edde74
B-step1        key=u5:再跑一下      id=a429dffaca0329d689bd0557ace183f6
C-step1        key=u8:跑一下        id=bae45ae8eda795f6e4a9f4102e8c6cf2
D-multimodal   key=u0:看这张图      id=9003c2d8e54dd30d52756611bf8aff4c
E-no-user      key=(空 — 无用户文本，网关回落请求级随机 ID，每次不同)
```

A 轮三个 step 的聚合 ID 完全相同 —— 轮内 tool call 多轮不会换键，
**一次对话轮在上游后台只记一条**。
