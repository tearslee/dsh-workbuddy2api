# dsh-workbuddy2api

把 [workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) 网关接进 [DeepSeek Harness（dsh）](https://www.npmjs.com/package/@deepseek-ai/dsh) 的插件。

装好之后：**dsh 启动时自动拉起网关，退出时自动回收；模型列表、上下文窗口、思考档位全部从网关自动读取** —— 不需要再手写 `settings.yaml` 里的模型元数据。

---

## 它解决什么

直接用手工配置把 workbuddy2api 接进 dsh（在 `~/.dsh/settings.yaml` 写 `llm-pi-ai.providers.workbuddy2api`）能用，但有三处手工负担：

| 问题 | 手工接法 | 本插件 |
|---|---|---|
| **模型元数据** | 每个模型的 `contextWindow` / `maxTokens` / `reasoningEfforts` / `input` 全手抄；上游增删模型必须手改文件 | 运行时读 `GET /v1/models` 的扩展字段自动映射 |
| **进程管理** | dsh 启动前必须另行常驻 `wb2api-server.exe`，退出也不联动 | 插件托管子进程，生命周期绑定 dsh |
| **可分发** | 配置只存在于本机，别人拿不到 | 一个 npm 包，装上即可用 |

关键前提：workbuddy2api 的 `/v1/models` **已经透出全部元数据**（`internal/server/handler.go` 的 `modelList()`，见上游 issue #84）。插件不需要内置静态兜底表，也不需要给上游提 PR。

### 字段映射

| 网关 `/v1/models` | dsh `LlmResolvedModelInfo` |
|---|---|
| `context_length` | `context.contextWindow` |
| `max_output_tokens` | `defaultMaxTokens` |
| `supports_images` | `inputModalities`（缺席 = 仅 `['text']`） |
| `reasoning_supported_efforts` | `reasoning.efforts` |
| `reasoning_default_effort` | `reasoning.defaultEffort`（先校验包含于 `efforts`） |

> 内置的 `openai-completions` 栈不认这些非标准字段，这正是当初必须手写元数据的根因 —— 也是本插件的核心价值。

---

## 架构

```
dsh 进程（TypeScript）
└── 插件 dsh-workbuddy2api
    ├── ① 进程托管  GatewaySupervisor：spawn → /healthz 探活 → dispose 自动回收
    ├── ② provider  注册 workbuddy2api 路由；listModels/resolveModel 打 /v1/models
    └── ③ 管理面    /wb2api-status · /wb2api-start · /wb2api-restart · /wb2api-login
            │ HTTP（openai-completions 协议）
            ▼
    wb2api 子进程 :7863（Go）
    账号池加权选号 · 分级熔断 · 六类定时任务 · SSE 重建 · payload 改写
```

**职责边界**：协议适配、账号池、熔断、定时任务、CodeBuddy 登录与 token 刷新**全部留在 Go 侧**。插件只解决「进程生命周期」与「模型目录自动化」两件事，因此适配器是一层很薄的 SSE 翻译。

---

## 前置条件

1. **dsh** ≥ `0.1.6-alpha.1`（`npm i -g @deepseek-ai/dsh`）
2. **workbuddy2api 的可执行文件**。上游[明确不提供预编译 release](https://github.com/Sliverkiss/workbuddy2api)，需要自行从源码构建：

   ```bash
   git clone https://github.com/Sliverkiss/workbuddy2api
   cd workbuddy2api
   go build -o wb2a-server.exe ./cmd/server
   ```

3. **至少一个已登录的账号**（网关没有账号时 `/healthz` 会报 `healthy: 0`）：

   ```bash
   ./login.sh        # 交互式 OAuth，必须在真实终端里跑
   ```

---

## 安装

```bash
dsh plugin --profile web add dsh-workbuddy2api
```

装完重启 dsh（关闭再执行 `dsh web`）。

### 从源码安装（未发布到 npm 时）

```bash
git clone https://github.com/tearslee/dsh-workbuddy2api
cd dsh-workbuddy2api
pnpm install
node node_modules/typescript/bin/tsc -p tsconfig.json   # 必须先构建出 lib/
pnpm pack                                                # 生成 dsh-workbuddy2api-0.1.0.tgz
dsh plugin --profile web add file:./dsh-workbuddy2api-0.1.0.tgz
```

> **不要用 `dsh plugin install <源码目录>`**：pnpm 会写成 `link:` 依赖，而 Windows 上工具进程创建的 junction 不可遍历，会导致 pnpm 全面失效。用 `pnpm pack` 出的 tarball（解包成真实目录）可规避。

---

## ⚠️ 迁移：先删掉冲突的旧配置

插件注册 `workbuddy2api` 路由后，如果 `~/.dsh/settings.yaml` 里还留着同名 provider，启动日志会出现：

```
[workbuddy2api] provider 目录注册被拒：configurable provider "workbuddy2api" is already declared
[workbuddy2api] 适配器注册被拒（DUPLICATE_ADAPTER）：an adapter for provider "workbuddy2api" is already registered
[workbuddy2api] provider 路由 "workbuddy2api" 由外部配置占用（见上条）。请删除 ...
```

**dsh 仍会正常启动**（插件故意不把冲突抛出去，避免把一个本来可用的环境弄成起不来）：
此时模型请求走的是 `settings.yaml` 里那份手工配置，本插件的自动元数据不会生效。
`/wb2api-status` 也会显示这条警告。

从 `~/.dsh/settings.yaml` **删除整段**（连同它下面那 20 个模型的元数据）后重启即可：

```yaml
llm-pi-ai:
  providers:
    workbuddy2api:      # ← 从这一行删到该 provider 段的末尾
```

**其余引用保持不变** —— provider id 没变，所以这些无需改动：

```yaml
agent-default-model:
  provider: workbuddy2api       # 保持不变
subagent-model-selection:
  allowedModels:
    - provider: workbuddy2api   # 保持不变
```

改完重启 dsh。

---

## 配置

插件配置写在 profile 的 `cordis.patch.yml` 里（或任何引用 `id: workbuddy2api` 的补丁）。全部字段都可省略：

```yaml
- insert:
    - id: workbuddy2api
      name: 'dsh-workbuddy2api'
      config:
        baseURL: http://127.0.0.1:7863/v1
        binaryPath: D:/tools/workbuddy2api/wb2a-server.exe
        repoPath: D:/tools/workbuddy2api
        autoStart: true
        realmPrefixPolicy: strip-cn
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:7863/v1` | 网关 OpenAI 兼容端点根 |
| `apiKeyRef` | `WORKBUDDY2API_API_KEY` | dsh 凭据库里的 ref 名 |
| `binaryPath` | `''` | 网关可执行文件绝对路径；为空则自动探测 |
| `repoPath` | `''` | 网关源码目录（也用作默认工作目录） |
| `workingDir` | `''` | 子进程工作目录；为空时取 `repoPath` |
| `listenPort` | `7863` | 仅用于端口占用判定与状态展示 |
| `autoStart` | `true` | dsh 启动时自动拉起网关 |
| `realmPrefixPolicy` | `strip-cn` | 模型 id 的 realm 前缀策略，见下 |
| `modelsTtlSeconds` | `600` | `/v1/models` 缓存 TTL |
| `requestTimeoutSeconds` | `600` | 单次请求整体超时 |
| `idleTimeoutSeconds` | `300` | SSE 帧间空闲超时（超时报可重试 `TIMEOUT`） |
| `firstTokenTimeoutSeconds` | `120` | 首个 token 等待超时 |
| `healthTimeoutSeconds` | `3` | 单次探活超时 |
| `graceMs` | `5000` | 子进程优雅退出宽限期 |
| `crashRestartLimit` | `3` | 崩溃自动重启上限 |
| `env` | `{}` | 传给网关子进程的显式环境变量 |

### `apiKey` 的解析顺序

1. dsh 凭据库（`~/.dsh/.credentials.yaml` 的 `refs.WORKBUDDY2API_API_KEY`）
2. 同名环境变量
3. 网关自己的 `config.json` 里的 `api_key`

同机部署时第 3 条即可命中，**通常无需任何额外配置**。

> 子进程环境会被 dsh 清洗（凭据形名称与 `DSH_*` 全部移除），所以网关需要的变量必须经上面的 `env` 显式传入。

### `realmPrefixPolicy`：模型 id 的前缀策略

网关的模型 id 带 realm 前缀（`cn:deepseek-v4.1-flash` / `global:gpt-5.4`）。

- **`strip-cn`（默认）** —— 剥掉 `cn:`，保留 `global:`。模型列表里的 id 与你手工配置时期一致，历史会话与预设无需迁移。
- **`keep`** —— 原样透出 `cn:` / `global:`。双域账号并存时可显式路由到国际版账号。

> 两种策略在只有 CN 账号时**行为一致**：网关的 `resolveModel` 对无前缀名一律判为 `cn` 域。
>
> **线格式与展示是两件事**：无论哪种策略，插件发出请求前都会把无前缀 id 补成 `cn:<id>`，避免 realm 解析歧义。

---

## 命令

| 命令 | 作用 |
|---|---|
| `/wb2api-status` | 网关状态、账号可用性（`healthy/total`）、realm 可服务性、模型数量 |
| `/wb2api-start` | 启动网关（幂等：已在运行则直接复用） |
| `/wb2api-restart` | 重启网关并刷新模型目录 |
| `/wb2api-login` | 显示登录指引 |

### 登录为什么必须手工做

账号登录是**交互式 OAuth**，需要真实终端与浏览器。dsh 的命令处理器没有 TTY，无法代你完成授权 —— 所以 `/wb2api-login` 只给出指引，实际登录请在终端里跑 `./login.sh`，完成后回 dsh 执行 `/wb2api-restart`。

---

## 已知限制

- **`global:` 模型的元数据是占位值。** 上游 `modelList()` 的 global 分支把 `context_length` 硬编码为 `131072`，且下发 `max_output_tokens` 与 `supports_images`。所以国际版模型的窗口/输出上限**不是真实值**。CN 侧无此问题（走动态拉取）。
- **无账号时网关"启动 ≠ 可用"。** 进程起来但 `/healthz` 报 `healthy: 0`，插件会把状态标为「运行中（无可用账号）」而不是假装成功。
- **不做按需 `go build`。** 本版要求你自行准备好二进制（`binaryPath` 或 `repoPath` + 自动探测）。构建编排留待后续。

---

## 合规声明

- 本插件**不包含、不转发、不再分发 workbuddy2api 的任何二进制或源码**。它只托管并消费你自己构建的产物。
- workbuddy2api 的许可与免责声明由其自身条款约束（上游 README 明确「无预编译 release，产物 = 源码自构建」）。使用前请自行阅读。
- 本插件以 MIT 许可发布，与上游无隶属关系。

---

## 开发

```bash
pnpm install
node node_modules/typescript/bin/tsc -p tsconfig.json   # 构建（不要用 pnpm build）
node node_modules/vitest/vitest.mjs run                  # 单元测试
```

集成测试会**真实发起对话**（消耗账号额度），需显式开启：

```powershell
$env:DSH_WB2API_E2E='1'; $env:DSH_WB2API_E2E_CONFIRM='yes'
$env:DSH_WB2API_E2E_API_KEY='<网关 api_key>'
node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts
```

### 代码结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：注册 provider、命令、生命周期 |
| `src/config.ts` | 插件配置 schema 与默认值 |
| `src/models.ts` | `/v1/models` 拉取、映射、TTL 缓存 |
| `src/gateway-adapter.ts` | `LlmAdapter` 实现：请求组装 + SSE → `StreamChunk` |
| `src/gateway-supervisor.ts` | 子进程托管：探测、spawn、探活、重启、回收 |
| `src/sse.ts` | SSE 空闲超时读取、工具参数归一化、孤儿工具配对清理 |
| `docs/` | 设计交接文档 |

### 为什么有几处写法看起来"多余"

这些都有具体原因，改动前请先读对应注释：

- **`Config` 必须用 `Schema.object({...})` 构造** —— `settings.describe()` 会对每个注册项调用 `schema.toJSON()`，传裸函数会抛 `TypeError`，连带让模型设置页、主题、sidebar 的 settings API 全部失效（见 `src/config.ts`）。
- **SSE 按 `\n` 切行而不是 `\n\n` 切事件** —— 网关一帧 = 一行 `data:`。
- **工具 `id` 靠 Map 按 `index` 复用** —— 只有首个分片带 `id`。
- **`function.name` 只在非空时更新** —— 后续分片带 `""`（不是 `undefined`），直接覆盖会导致 `unknown tool ""`。
- **残缺工具参数报 `max-tokens` 而不是 `tool-calls`** —— 报 `tool-calls` 会让 harness 执行半截 JSON 并把脏参数写进会话历史，报 `max-tokens` 才会丢弃并重试。
- **`readWithIdleTimeout` 的 abort 分支也要 reject** —— 只清定时器会让 `Promise.race` 永远悬空，generator 既不产出也不返回。
- **provider 注册冲突只记日志、不抛错** —— 冲突意味着用户还没迁移旧配置，此时抛错会让 dsh 起不来，把一个可用环境变成完全不可用。

---

## 许可

MIT
