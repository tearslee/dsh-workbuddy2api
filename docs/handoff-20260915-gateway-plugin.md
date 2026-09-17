# handoff-20260915 — dsh 网关插件（dsh-workbuddy2api）

| 项 | 值 |
|---|---|
| 状态 | **已实施**（本文档是 2026-09-15 的方案与调研记录，代码已按此落地） |
| 目标产物 | 独立发布的 dsh 插件 `dsh-workbuddy2api` |
| 上游依赖 | [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（Go，MIT，**只消费不改**） |
| 工程骨架来源 | `deepseek-harness-codearts`（gitee.com/iJetLi/deepseek-harness-codearts）的 buddy provider 构建链 |
| 环境 | dsh `0.1.6-alpha.1`（单份全局安装，`<dsh 安装目录>/node_modules/@deepseek-ai/dsh`）|

> **读这份文档前请先看这里**：下文所有 `handler.go:229-256` 之类的**行号引用**对应的
> 是 2026-09-15 的上游基线 `3b87c14`。上游此后前进了 127 个提交（当前基线 `a9ccace`），
> 行号已整体漂移 —— 检索时请以**函数名**为准（`modelList()`、`healthz()`、
> `applyModelInfoFields()` …），不要按行号跳转。
>
> 当前行为以 [../README.md](../README.md) 与
> [turn-level-aggregation.md](turn-level-aggregation.md) 为准。

---

## 1. 起因

管理员要求：**把 workbuddy2api 做成 dsh 插件** —— 装好插件后能在 dsh 内直接启动网关，并自动把网关的模型配好；插件**独立发布**，不作为 workbuddy2api 的项目组成部分。

现状（已被验证可用，但不满足目标）走的是 dsh 的「自定义 provider」配置接法：`~/.dsh/settings.yaml` 里 `agent-default-model.provider = workbuddy2api`，`llm-pi-ai.providers.workbuddy2api` 指向 `http://127.0.0.1:7863/v1`。该接法有三处手工负担：

1. **模型元数据全手写** —— `settings.yaml:9-109` 手抄了 20 个模型的 `contextWindow` / `maxTokens` / `reasoningEfforts` / `input`，上游增删模型必须手改文件。
2. **进程要人管** —— dsh 启动前必须另行常驻 `wb2api-server.exe`（:7863），退出也不联动。
3. **配置只在本机** —— 上述内容不存在于任何可分发物里，别人拿不到。

---

## 2. 现状与约束（先读这节，能省大量摸索）

### 2.1 决定性发现：网关已经透出全部元数据，插件不需要任何兜底表

`workbuddy2api/internal/server/handler.go` 的 `modelList()` 已经返回：

| 网关字段 | 含义 | 代码位置（按函数名检索） |
|---|---|---|
| `id` | 模型 id，**带 realm 前缀**（`"cn:" + mi.ID`） | `modelList()` |
| `context_length` | 上下文窗口 | `upstream/model_catalog.go` `ContextWindowListingV4()` |
| `max_output_tokens` | 输出上限（未收录时该键省略） | `upstream/model_catalog.go` `MaxOutputTokensListingV4()` |
| `supports_images` | 多模态能力（仅在支持时出现） | `applyModelInfoFields()` |
| `reasoning_supported_efforts` | 可选思考档位 | `upstream/effort_catalog.go` `EffortListing()` |
| `reasoning_default_effort` | 默认档位 | 同上 |

> **方案期结论已部分被上游修正**（2026-09-17 复核）：当时 `context_length` 在零值时
> 兜底 131072、且 `global:` 分支不下发 `max_output_tokens`；上游现已改为**四级查找链**
> （上游动态值 → 静态种子表 → `model.json` 缓存 → models.dev，全 miss 才兜底 1M）
> 并两域同口径透出富字段。**插件侧的收益不变**：它依旧是把这批非标准字段翻译成
> dsh `LlmResolvedModelInfo` 的那一层。

代码注释写明这是 **issue #84「客户端可发现档位，不再盲传」** 的产物（`handler.go:247-248`）。

> **推论：管理员手写在 settings.yaml 的那 20 条元数据，全部可以从 `/v1/models` 自动取到。插件不需要内置静态兜底表，也不需要给 workbuddy2api 提 PR 补接口。** 这正是插件化最大且最确定的收益。

### 2.2 四个已验证的 dsh 原生能力

| 能力 | 机制 | 证据 |
|---|---|---|
| 程序化注册 provider | `ctx.llm.registerConfigurableProviders([{provider, displayName, settingsNs, settingsPath}])` + `ctx.llm.registerAdapter([pid], adapter)` | codearts `src/buddy-adapter.ts:928-933`、`src/llm-adapter.ts:1416-1421` |
| 模型元数据完全可编程 | `listModels()` / `resolveModel()` 由适配器实现，可返回 contextWindow、efforts、inputModalities | `buddy-adapter.ts:452-492` |
| 托管子进程 + 生命周期绑定 | `ctx.subprocess.resolveExecutable()` / `spawn({argv, cwd, stdio, graceMs, env})` → `handle.done` / `terminate()` / `waitForExit()`；**服务 dispose 终止全部受管进程**；`spawnTerminal()` 提供真 PTY | `@deepseek-ai/dsh-subprocess/README.zh.md` |
| 贡献 Web UI + 自有 RPC 端点 | `dsh.client.inject` + `platform: web`；前端 esbuild 打包；服务端经 `ctx.connection` 注册 POST 端点 | codearts `plugin-src/client/*`、`src/jet-hub-rpc.ts:59-121` |

### 2.3 硬约束（违反其一方案即不成立）

1. **dsh 插件是进程内 TS 模块**（cordis `apply(ctx)`）。Go 二进制**无法**作为插件运行，只能是插件托管的子进程。
2. **npm/pnpm 不能把 Go 模块当依赖**。`dsh plugin add` 只调 pnpm，pnpm 不构建 Go。
3. **每个组合只能有一个 `subprocess` provider**；`ctx.llm.registerAdapter()` 对已被占用的路由抛 `DUPLICATE_ADAPTER`（`dsh-llm/lib/types/index.d.ts:243-250`）。→ 插件注册 `workbuddy2api` 路由前，**必须先把 settings.yaml 里同名 provider 删掉**（见 §3.6）。
4. **provider id 永久不可改** —— 请求日志、会话历史、凭据引用都以该 id 为主键，改名等于删旧建新并孤立历史。
5. **子进程环境被清洗**（凭据形名称与 `DSH_*` 全部移除，`README.zh.md`「每个子进程起步时的环境」），需要的变量必须通过显式 `env` 传入。
6. **上游许可边界**：workbuddy2api README 明确「无预编译 release，产物 = 源码自构建」「本项目内所有资源文件禁止任何形式的转载、发布」「免责声明与 MIT 不一致时以免责声明为准」。→ **代发它的二进制有合规风险**（见 §3.5 方案 C）。

### 2.4 网关的鉴权与健康检查（写代码时要用）

| 端点 | 鉴权 | 位置 |
|---|---|---|
| `GET /healthz` | **无鉴权** | `handler.go:94` |
| `GET /v1/models` | `Authorization: Bearer <api_key>`（`config.APIKey` 非空时） | `handler.go:92,102-110` |
| `POST /v1/chat/completions` | 同上 | `handler.go:91` |
| `GET /status` | 同上（账号池/冷却台账） | `handler.go:93` |

---

## 3. 方案

### 3.1 架构：插件三块职责

```
dsh 进程（TS）
└── 插件 dsh-workbuddy2api
    ├── ① 进程托管   spawn wb2api → /healthz 探活 → dispose 自动收
    ├── ② provider   注册 workbuddy2api 路由；listModels/resolveModel 打 /v1/models
    └── ③ 管理面     /wb2api-status 等命令（Web 面板后置）
            │ HTTP（openai-completions 协议）
            ▼
    wb2api 子进程 :7863（Go）
    账号池加权选号 · 分级熔断 · 六类定时任务 · SSE 重建 · payload 改写
```

**职责边界**：协议适配、账号池、熔断、定时任务**全部留在 Go 侧**（那边实现更全，且含管理员自己的贡献）；插件只解决「进程生命周期」与「模型目录自动化」两件事。

### 3.2 必须自带适配器，不能寄生于 `llm-pi-ai`

`dsh-llm-pi-ai` 确实支持从 Config 注册 provider（`lib/index.js:1018` `Config = z.object({providers: z.dict(profile)})` → `:2627` `registerConfigurableProviders` → `:2657` `registerAdapter`），理论上可以用 patch 把 provider 配置注入进去，**完全不用写适配器**。

**但这条路达不到目标**：那只 Config 是 schemastery 校验的**静态**配置，模型列表与元数据写死在 `cordis.patch.yml` / profile 里 —— 和现在的手写 settings.yaml 是同一个问题，只是换了个文件。要"自动配好模型"，只能由插件在运行时实现 `listModels()` / `resolveModel()`。

> 换句话：插件的核心价值就是**把 `/v1/models` 的扩展字段翻译成 dsh 的 `LlmResolvedModelInfo`** —— 这是内置的 openai-completions 栈做不到的（它不认 `context_length` / `reasoning_supported_efforts` 这些非标准字段），也是管理员当初必须手写那 20 条元数据的根因。

### 3.3 接口契约（`LlmAdapter`）

抽象基类见 `dsh-llm/lib/types/index.d.ts:128-185`。**只有 `stream()` 是 abstract**，其余均有默认实现，按需覆盖：

| 方法 | 是否必须 | 本插件是否覆盖 | 说明 |
|---|---|---|---|
| `stream(options): AsyncIterable<StreamChunk>` | **必须** | ✅ | 唯一 abstract。POST `/v1/chat/completions`（`stream:true`），解析 SSE 转 StreamChunk |
| `providerInfo(provider)` | 可选 | ✅ | 返回 `{id, name}`，`id` 必须等于注册的路由名 |
| `listModels(_provider)` | 可选 | ✅ | 打 `/v1/models` → `LlmModelInfo[]` |
| `resolveModel(provider, model, signal)` | 可选 | ✅ | 打 `/v1/models` → 带 context / defaultMaxTokens / reasoning |
| `prepareCall(provider, model, signal)` | 可选 | ✅ | 绑定"模型元数据 + 本次请求的 stream 入口"。**注意**：旧版 dsh-llm 无此方法会报 `registration.adapter.prepareCall is not a function`，codearts 有同款 shim（`buddy-adapter.ts:494-510`）可抄 |
| `providerRetryPolicy(_provider)` | 可选 | ❌ | 用默认策略 |
| `imageRequestPricing(_provider, _model)` | 可选 | ❌ | 无图片计价需求 |

**关键类型**（`dsh-llm/lib/types/types.d.ts`）：

- `LlmModelInfo`（`:291-302`）：`provider` / `id` / `name` / `description?` / `inputModalities?`
- `LlmModelContext`（`:304-307`）：`contextWindow`
- `LlmResolvedModelInfo extends LlmModelInfo`（`:354-363`）：`context?` / `defaultMaxTokens?` / `reasoning?` / `systemPromptUpdate?`
- `StreamChunk`（`:392-422`）：`block-start` | `text-delta` | `reasoning-delta` | `tool-call-delta` | `block-end` | `usage` | `finish`
- `GenerateOptions`（`:437+`）：`provider` / `model` / `reasoningEffort?` / `messages` / `system?` / `tools?` / `temperature?` / `maxTokens?` / `stop?` / `signal?`

**实现参考**：`codearts/src/buddy-adapter.ts` 是同类适配器的完整范本 —— SSE 解析（同目录 `src/sse.ts`）、思考块 `reasoning-delta` 映射、工具调用分片处理、`prepareCall` shim。**差异只在"目标端点"**：BuddyAdapter 直连 `copilot.tencent.com` 并自行处理登录/token/工具 id 稳定化；本插件打本地网关，**这些全部不需要**（token、重试、轮级聚合、tool pairing 都在 Go 侧，见 `internal/upstream/tool_pairing.go`、`internal/session/ids.go`）。

→ **适配器应当是薄的一层**：构造 OpenAI 请求体 → 发流 → 翻译 SSE。

### 3.4 元数据映射表（本插件的核心逻辑）

| `/v1/models` 字段 | dsh 目标字段 | 备注 |
|---|---|---|
| `id` | `LlmModelInfo.id` | **带 `cn:` / `global:` 前缀，需决策**（见下） |
| `context_length` | `LlmResolvedModelInfo.context.contextWindow` | |
| `max_output_tokens` | `LlmResolvedModelInfo.defaultMaxTokens` | |
| `supports_images` | `LlmModelInfo.inputModalities` | 缺席 = 仅 `['text']` |
| `reasoning_supported_efforts` | `LlmResolvedModelInfo.reasoning.efforts` | 用 `ReasoningEffortId(id)` 工厂包一层 |
| `reasoning_default_effort` | `...reasoning.defaultEffort` | **须先校验包含于 efforts 内**（照 `buddy-adapter.ts:486-488` 的写法） |

**待决策项（实施前需管理员拍板）：模型 id 的 realm 前缀。**

`/v1/models` 返回的是 `cn:deepseek-v4.1-flash` 这种带前缀 id（`handler.go:234`），而管理员现有 settings.yaml 用的是无前缀 id（走默认 realm）。三种策略：

- **A. 剥掉 `cn:` 前缀** —— 与现有配置行为一致，改动最小；但 `global:` 前缀必须保留（否则路由不到国际版账号）。
- **B. 原样透出** —— 显式 realm 路由，两个 realm 的账号都能被选到；但模型下拉会变得很长（CN + Global 各一份）。
- **C. 两者都注册** —— 兼容性最好，重复项最多。

建议 **A**，除非确认要同时用双域账号。

### 3.5 二进制来源（四条路，建议先 A 后 B）

| | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A** | config 填 `binaryPath`，指向用户已有的 `wb2api-server.exe` | 最轻，当天可跑通；不碰构建与许可 | 用户得自己有产物 |
| **B** | 首次运行时按 `repoPath`（或 clone 上游）执行 `go build`，产物缓存到 `~/.dsh/wb2api/bin/` | **不代发二进制，合规干净**；源码自构建与上游定位一致 | 要求 Go 工具链；首启几十秒。**建议做惰性构建而非 `postinstall`** —— 后者要改 profile 的 `pnpm-workspace.yaml` 放行 `allowBuilds`，插件热重载时不易控制 |
| **C** | 插件包内嵌预编译二进制（`files: ["lib","bin"]`，按平台分包，esbuild/swc 的 `optionalDependencies` 模式） | 用户零额外依赖 | 需自建 CI 出多平台产物；**与上游「无预编译 release」「禁止转载发布」「免责声明优先」直接冲突，合规风险** |
| **D** | 插件 spawn `docker compose up -d` | 隔离干净 | 要求 Docker；compose 文件位置与 `auths/` 凭证挂载要处理 |

**推荐**：先 A 把端到端链路跑通（不碰构建，快速验证 provider 注册与元数据映射），再补 B 做分发。C 仅在确认法务/许可无虞后再考虑，D 作为可选项。

### 3.6 前置坑：网关「启动 ≠ 可用」（比插件本身更要紧）

wb2api 需要 `auths/*.json` 账号凭证（`internal/pool` 启动时按 `auths/` 目录对齐），而登录是**交互式 OAuth**（`./login.sh`，Go 二进制 `cmd/login`）。因此「配好插件就能用」的完整链路必须包含登录编排：

- 用 `ctx.subprocess.spawnTerminal()`（真 PTY）或直接 spawn `login` 二进制；
- 插件应提供 `/wb2api-login` 命令编排该流程，并用 `/healthz` 的 `healthy` / `total` 字段（`README.md` 快速开始节）暴露"有无可用账号"。

**不做这一步，插件把端口拉起来了，`/healthz` 依然是 503。**

### 3.7 迁移：清理现有配置（否则注册冲突）

插件注册 `workbuddy2api` 路由后，必须从 `~/.dsh/settings.yaml` 删除：

```yaml
llm-pi-ai:
  providers:
    workbuddy2api:      # ← 整段删除（20 个模型的元数据随之作废）
```

`agent-default-model.provider` 与 `subagent-model-selection.allowedModels` 里的 `workbuddy2api` 引用**保持不变**（provider id 相同，无需改动）。以 `DUPLICATE_ADAPTER` 报错为触发信号回溯本节。

---

## 4. 文件清单

### 4.1 从 codearts 复用的构建链（逐项照抄/裁剪）

| 文件 | 复用内容 |
|---|---|
| `package.json` | `scripts.build`（tsc）、`build:client`（esbuild）、`typecheck`、`test`；`dsh.bundle.patch` + `dsh.client.platform` 声明（`codearts/package.json:34-41`）；`peerDependencies` 的 `@deepseek-ai/*` 版本区间 |
| `tsconfig.json` / `vitest.config.ts` | 原样 |
| `cordis.patch.yml` | `insert: [{id, name}]` 形式，把插件行插进 layer 栈 |
| `src/index.ts` | 插件入口骨架：`name` / `inject` / `apply(ctx)`；settings namespace 注册（**必须用 `Schema.object()`，裸函数会让 `settings.describe()` 抛 `registration.schema.toJSON is not a function`**，见 `codearts/src/index.ts:16-73` 的长注释） |
| `src/sse.ts` | SSE 帧解析 |
| `src/buddy-adapter.ts` | 适配器结构范本（`providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream` 五个方法的组织方式） |
| `plugin-src/client/build.mjs` | Web UI 打包（**二期**再做，一期只需命令） |

### 4.2 本插件新建

| 文件 | 职责 |
|---|---|
| `src/gateway-supervisor.ts` | 进程托管：`resolveExecutable` → `spawn` → `/healthz` 探活 → dispose 时 terminate；崩溃重启策略 |
| `src/gateway-adapter.ts` | `LlmAdapter` 实现：把 `GenerateOptions` 组装成 OpenAI 请求体，SSE → `StreamChunk` |
| `src/models.ts` | `GET /v1/models` 拉取 + 缓存（TTL）+ §3.4 映射 + realm 前缀策略 |
| `src/config.ts` | 插件 `Config` schema：`baseURL` / `apiKeyEnv` / `binaryPath` / `repoPath` / `listenPort` / `autoStart` / `realmPrefixPolicy` |
| `src/index.ts` | 注册 provider、命令（`/wb2api-status` / `/wb2api-login` / `/wb2api-restart`）、生命周期 |
| `docs/handoff-20260915-gateway-plugin.md` | 本文件 |

### 4.3 涉及的外部文件（只读参考，不修改）

- `workbuddy2api/internal/server/handler.go`（路由、元数据）
- `workbuddy2api/README.md`（端点行为、许可边界）
- `deepseek-harness-codearts/src/*`（构建链与适配器范本）
- `~/.dsh/settings.yaml`（**要改**：§3.7 删除冲突 provider）
- dsh 内核类型：`@deepseek-ai/dsh-llm/lib/types/*.d.ts`、`@deepseek-ai/dsh-subprocess/README.zh.md`

### 4.4 明确不做

- ❌ 不把插件代码提交进 `Sliverkiss/workbuddy2api`（Go 项目，加 TS = 引入第二套工具链，破坏架构边界；其 `client_integration.yml` 模板已把客户端定义为**消费者**）
- ❌ 不重写池治理 / 熔断 / 定时积分任务（Go 侧更全：四因子加权选号、分级冷却、在途租约、账本择优、六类定时任务）
- ❌ 不代发上游二进制（除非 §3.5-C 的许可问题解决）
- ❌ 不自行实现 CodeBuddy 协议适配（登录、token 刷新、工具 id 稳定化、思考链注入、会话头族、指纹脱敏全在 Go 侧）

---

## 5. 验证

| # | 项 | 方法 | 通过判据 |
|---|---|---|---|
| 1 | 构建 | `node node_modules/typescript/bin/tsc -p tsconfig.json` | `lib/index.js` 生成。**不要用 `pnpm build`**——本机 pnpm script 是「假成功」（日志只有 cmd.exe 欢迎信息，实际不执行 tsc） |
| 2 | 单元测试 | `node node_modules/vitest/vitest.mjs run` | 元数据映射、SSE 翻译的用例全绿 |
| 3 | 插件进 layer 栈 | `dsh --profile web --dump-config` | 输出里出现插件包名。**注意本机的 junction 陷阱**：刚装新 bundle 后不要让工具进程跑 `--dump-config`（会建出不可遍历的 junction），交给用户真实终端 |
| 4 | 网关被拉起 | 启动 dsh 后 `netstat -ano \| findstr ":7863"` | 有 LISTENING；`curl http://127.0.0.1:7863/healthz` 返回 `{"healthy":N,"total":M,"service":"workbuddy2api"}` |
| 5 | 模型自动出现 | dsh 设置页 → 模型 | provider `workbuddy2api` 下列出模型，且**上下文窗口与档位与 `/v1/models` 一致**（对照 `curl -H "Authorization: Bearer <key>" .../v1/models`） |
| 6 | 端到端对话 | 在 dsh 里用该 provider 发一轮带工具调用的请求 | 文本正常、思考链可见（`reasoning-delta`）、工具调用配对正确 |
| 7 | 生命周期 | 关闭 dsh | :7863 随之释放，无残留进程 |
| 8 | 迁移无冲突 | 按 §3.7 删掉 settings.yaml 冲突段后重启 | 无 `DUPLICATE_ADAPTER` |

---

## 6. 风险与回滚

| 风险 | 触发症状 | 应对 / 回滚 |
|---|---|---|
| provider 路由冲突 | 启动报 `DUPLICATE_ADAPTER` | 删 `settings.yaml` 里 `llm-pi-ai.providers.workbuddy2api`（§3.7） |
| dsh 版本漂移导致适配器契约变化 | `registration.adapter.prepareCall is not a function` 之类 | 抄 `buddy-adapter.ts:494-510` 的 shim；锁定 `peerDependencies` 版本区间 |
| 子进程环境被清洗 | 网关起不来、缺环境变量 | 用 `spawn` 的显式 `env` 传（凭据形名称与 `DSH_*` 会被主动移除） |
| 端口占用 | 插件 spawn 后立刻退出 | spawn 前探 `:7863`；占用时给出明确错误而非静默失败 |
| 网关无账号 | `/healthz` 返回 503 | 插件把 `healthy/total` 透出到状态命令，引导 `/wb2api-login` |
| 二进制分发合规 | 若走 §3.5-C | 回退到 A / B；不要在未确认的许可前提下发布含上游二进制的包 |
| 整体回滚 | —— | 停用插件 → 恢复 `settings.yaml` 里 `llm-pi-ai.providers.workbuddy2api` 原段落 → 回到当前的配置接法（本文档 §1 描述的现状） |

---

## 7. 关联文档与证据索引

- 上游仓库：https://github.com/Sliverkiss/workbuddy2api （本文档的调研基线为 `3b87c14`；当前基线 `a9ccace`）
- 工程骨架来源：https://gitee.com/iJetLi/deepseek-harness-codearts
- dsh 插件开发教程：https://dev.to/henry_lin_3ac6363747f45b4/deepseek-harness-dsh-cha-jian-kai-fa-jiao-cheng-4h6j
- dsh 自定义 provider（用户视角）：https://findharness.com/blog/deepseek-harness-custom-model-providers
- 本机 dsh 插件安装/排障手册：`~/.workbuddy/skills/dsh-plugin-install/SKILL.md`
- 当日调研记录：本机 `.workbuddy/memory/2026-09-15.md`（「把 workbuddy2api 改造成 dsh 插件」两节）

**证据行号速查**（**行号对应基线 `3b87c14`，已漂移**——仅供回溯当时的调研，检索请用函数名）

| 主题 | 位置 |
|---|---|
| LlmAdapter 契约 | `@deepseek-ai/dsh-llm/lib/types/index.d.ts:128-185` |
| StreamChunk / GenerateOptions / LlmModelInfo | `@deepseek-ai/dsh-llm/lib/types/types.d.ts:291-465` |
| llm-pi-ai 的 provider 注册 | `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1018, 2565, 2627, 2657` |
| subprocess API 与 dispose 语义 | `@deepseek-ai/dsh-subprocess/README.zh.md` |
| 网关路由与鉴权 | `workbuddy2api/internal/server/handler.go:91-110` |
| 网关模型元数据 | `workbuddy2api/internal/server/handler.go:229-256` |
| 适配器范本 | `deepseek-harness-codearts/src/buddy-adapter.ts:408-510, 928-933` |
| 插件入口与 settings 注册陷阱 | `deepseek-harness-codearts/src/index.ts:16-73` |
| 现有配置（待迁移） | `~/.dsh/settings.yaml:3-6, 9-109, 110-118` |
