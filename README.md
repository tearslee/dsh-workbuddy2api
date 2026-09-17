# dsh-workbuddy2api

**把 [workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) 网关接进 [DeepSeek Harness（dsh）](https://www.npmjs.com/package/@deepseek-ai/dsh) 的插件。**

装上之后：

- **dsh 启动时自动拉起网关，退出时自动回收**；端口上已有健康网关在跑则直接复用，不重复拉起，也不会去杀别人的进程。
- **模型目录自动同步** —— 模型列表、上下文窗口、输出上限、思考档位全部从网关 `GET /v1/models` 实时读取，不必再手写 `settings.yaml` 里的模型元数据。
- **4 条管理命令**：`/wb2api-status` · `/wb2api-start` · `/wb2api-restart` · `/wb2api-login`。

插件本身很薄：协议适配、账号池、加权选号、分级熔断、定时任务、登录与 token 刷新**全部留在 Go 网关侧**。它只负责两件事 —— 进程生命周期，和模型目录自动化。

---

## 它解决什么

直接用手工配置把 workbuddy2api 接进 dsh（在 `~/.dsh/settings.yaml` 里写 `llm-pi-ai.providers.workbuddy2api`）也能用，但有三处手工负担：

| 问题 | 手工接法 | 本插件 |
|---|---|---|
| **模型元数据** | 每个模型的 `contextWindow` / `maxTokens` / `reasoningEfforts` / `input` 全手抄；网关增删模型必须手改文件 | 运行时读 `/v1/models` 自动映射 |
| **进程管理** | dsh 启动前必须另行常驻 `wb2a-server.exe`，退出也不联动 | 插件托管子进程，生命周期绑定 dsh |
| **可分发** | 配置只存在于本机，别人拿不到 | 一个 npm 包，装上即可用 |

### 字段映射

网关的 `/v1/models` 已经透出全部模型元数据（`internal/server/handler.go` 的 `modelList()`，对应上游 issue #84），因此插件**无需内置静态兜底表**：

| 网关 `/v1/models` | dsh `LlmResolvedModelInfo` | 说明 |
|---|---|---|
| `context_length` | `context.contextWindow` | 网关保证有值（四级查找链，见下） |
| `max_output_tokens` | `defaultMaxTokens` | 网关未收录时**不下发该键**，插件随之不声明 |
| `supports_images` | `inputModalities` | 缺席即仅 `['text']` |
| `reasoning_supported_efforts` | `reasoning.efforts` | 空则不声明整个 `reasoning` |
| `reasoning_default_effort` | `reasoning.defaultEffort` | 插件先校验它确实包含于 `efforts` 内 |

> 内置的 `openai-completions` 栈不认这些非标准字段 —— 这正是当初必须手写元数据的根因，也是本插件的核心价值。
>
> 网关侧对 `context_length` / `max_output_tokens` 走**四级查找链**：上游动态值 → 静态种子表 → `model.json` 缓存 → models.dev 按需拉取；全未命中时窗口兜底 1M、输出上限省略。`cn:` 与 `global:` 两域同口径。

### 为什么不破坏上游的「按轮聚合」

本插件的请求序列化有两条硬约束：**工具结果必须发成 `role:"tool"`**、**用户消息的内容与顺序在轮内逐字不变**。破坏任一条，上游按对话轮聚合 RequestID 的兜底键就会在每个 step 漂移，用量明细重新碎片化 —— 且是静默的（网关照常回包）。

原理、实测截图与端到端证据：[docs/turn-level-aggregation.md](docs/turn-level-aggregation.md)。

---

## 前置条件

1. **dsh**，全局安装：

   ```bash
   npm i -g @deepseek-ai/dsh
   ```

   本插件在 dsh `0.1.6-alpha.1` 上验证通过；`package.json` 声明的兼容区间是 `>=0.1.2-rc.1 <0.2.0-0`。

2. **workbuddy2api 的可执行文件**。上游[明确不提供预编译 release](https://github.com/Sliverkiss/workbuddy2api)，需自行从源码构建：

   ```bash
   git clone https://github.com/Sliverkiss/workbuddy2api
   cd workbuddy2api
   go build -o wb2a-server.exe ./cmd/server
   ```

3. **至少一个已登录账号**（没有账号时 `/healthz` 报 `healthy: 0`）：

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

## 配置

插件配置写在 profile 的 `cordis.patch.yml` 里（或任何引用 `id: workbuddy2api` 的补丁）。全部字段都可省略：

```yaml
- insert:
    - id: workbuddy2api
      name: 'dsh-workbuddy2api'
      config:
        baseURL: http://127.0.0.1:7863/v1
        binaryPath: /path/to/workbuddy2api/wb2a-server.exe
        repoPath: /path/to/workbuddy2api
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
| `autoStart` | `true` | dsh 启动时是否自动拉起网关 |
| `realmPrefixPolicy` | `strip-cn` | 模型 id 的前缀策略，见下 |
| `modelsTtlSeconds` | `600` | `/v1/models` 缓存 TTL |
| `requestTimeoutSeconds` | `600` | 单次请求整体超时 |
| `idleTimeoutSeconds` | `300` | SSE 帧间空闲超时（超时报可重试的 `TIMEOUT`） |
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

- **`strip-cn`（默认）** —— 剥掉 `cn:`，保留 `global:`。模型 id 与你手工配置时期一致，历史会话与预设无需迁移。
- **`keep`** —— 原样透出 `cn:` / `global:`。双域账号并存时可显式路由到国际版账号。

> 只有 CN 账号时两种策略**行为一致**：网关的 `resolveModel` 对无前缀名一律判为 `cn` 域。
>
> **线格式与展示是两件事**：无论哪种策略，插件发出请求前都会把无前缀 id 补成 `cn:<id>`，避免 realm 解析歧义。

---

## 命令

| 命令 | 作用 |
|---|---|
| `/wb2api-status` | 网关状态、账号可用性（`healthy/total`）、各 realm 可服务性、模型数量 |
| `/wb2api-start` | 启动网关（幂等：已在运行则直接复用） |
| `/wb2api-restart` | 重启网关并刷新模型目录 |
| `/wb2api-login` | 显示登录指引 |

### 关于「复用外部网关」

启动前插件会先探 `GET /healthz`（**该端点无需鉴权**）：

- **端口上已有健康网关** → 直接复用，状态记为 `external`，插件**不会**再拉一个进程。这正是「以前手工常驻了一个 wb2api」的迁移场景：装完插件一切照旧可用，但那个进程仍归你管 —— dsh 退出时**不会**去杀它（插件不杀自己没启动的进程）。
- **端口空闲** → 解析可执行文件并 spawn，此后它的生命周期归 dsh，`dispose` 时一并回收。
- **端口被非网关程序占用** → 明确报错，而不是静默失败。

所以：**想让网关真正由 dsh 托管，先停掉你手工启动的那个进程**，再重启 dsh。`/wb2api-status` 的 `状态:` 一行会告诉你当前是哪种情形。

### 登录为什么必须手工做

账号登录是**交互式 OAuth**，需要真实终端与浏览器。dsh 的命令处理器没有 TTY，无法代你完成授权 —— 所以 `/wb2api-login` 只给出指引，实际登录请在终端里跑 `./login.sh`，完成后回 dsh 执行 `/wb2api-restart`。

---

## 已知限制

- **窗口/输出上限是「上游实际值 + 本地估计」的混合。** 网关对 `context_length` 走四级查找链：上游动态值权威 → 静态种子表 → `model.json` 缓存 → models.dev 按需拉取；**全未命中时兜底 1M**。因此冷门模型的窗口可能是兜底值而非真实值。`max_output_tokens` 同理，未收录时网关**不下发该键**，此时插件不声明 `defaultMaxTokens`，由网关自行决定。
- **无账号时网关「启动 ≠ 可用」。** 进程起来但 `/healthz` 报 `healthy: 0`，插件会把状态标为「运行中（无可用账号）」而不是假装成功。
- **不做按需 `go build`。** 本版要求你自行准备好二进制（`binaryPath`，或 `repoPath` + 自动探测）。构建编排留待后续。
- **模型不出现在「设置 → 模型」页，只在聊天窗口的模型选择器里。** 这是 dsh 的既定设计，不是本插件的缺陷：设置页本质是**配置文件编辑器**，`dsh-client-ui-settings-models` 只认 `llm-deepseek` 与 `llm-pi-ai` 两个 settings namespace，其余不渲染 provider 行；而本插件的 provider 是**代码注册的运行时路由**，模型目录来自网关 `/v1/models`，本就不属于那个界面管辖。要确认模型可用：看聊天窗口的模型选择器，或执行 `/wb2api-status`。

---

## 常见问题

### 启动日志出现 provider 注册被拒（`DUPLICATE_ADAPTER`）

插件注册 `workbuddy2api` 路由后，如果 `~/.dsh/settings.yaml` 里还留着同名 provider，会看到：

```
[workbuddy2api] provider 目录注册被拒：configurable provider "workbuddy2api" is already declared
[workbuddy2api] 适配器注册被拒（DUPLICATE_ADAPTER）：an adapter for provider "workbuddy2api" is already registered
```

**dsh 仍会正常启动**（插件故意不把冲突抛出去，避免把一个本来可用的环境弄成起不来），但此时模型请求走的是 `settings.yaml` 里那份手工配置，自动元数据不生效。`/wb2api-status` 也会显示这条警告。

**处理**：从 `~/.dsh/settings.yaml` 删除整段 `llm-pi-ai.providers.workbuddy2api`（连同它下面那批模型元数据），然后重启：

```yaml
llm-pi-ai:
  providers:
    workbuddy2api:      # ← 从这一行删到该 provider 段的末尾
```

**其余引用保持不变** —— provider id 没变，这些无需改动：

```yaml
agent-default-model:
  provider: workbuddy2api       # 保持不变
subagent-model-selection:
  allowedModels:
    - provider: workbuddy2api   # 保持不变
```

仓库自带脚本 `scripts/migrate-settings.ps1` 可按缩进精确摘除该段并自动备份（不重写整个文件，dsh 自己的注释与键顺序都保留）：

```powershell
# 先预览要删什么
pwsh -File scripts/migrate-settings.ps1 -WhatIf

# 确认后执行（请在 dsh 已关闭时做）
pwsh -File scripts/migrate-settings.ps1
```

脚本会打印回滚命令（把自动备份拷回来即可）。

> **为什么必须在 dsh 关闭时执行**：`settings.yaml` 是被**热监听**的（dsh-settings-file 用 chokidar 监视）。在 dsh 运行中删掉该段会立刻生效，而插件那份 provider 要等重启才会注册 —— 中间窗口里模型会不可用，正在进行的会话可能直接失败。

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
| `tests/unit/turn-key-contract.spec.ts` | 轮级聚合键的跨语言契约 |
| `docs/` | 设计文档与截图 |

### 为什么有几处写法看起来"多余"

这些都有具体原因，改动前请先读对应注释：

- **工具结果必须发成 `role:"tool"`** —— harness 把结果搭载在 user 角色消息里，原样发出会让网关的 `TurnKey` 取到工具输出、每个 step 换一个聚合键，**RequestID 碎片化因此静默复发**。详见 [轮级聚合](docs/turn-level-aggregation.md) 与 `tests/unit/turn-key-contract.spec.ts`。
- **`Config` 必须用 `Schema.object({...})` 构造** —— `settings.describe()` 会对每个注册项调用 `schema.toJSON()`，传裸函数会抛 `TypeError`，连带让模型设置页、主题、sidebar 的 settings API 全部失效。
- **SSE 按 `\n` 切行而不是 `\n\n` 切事件** —— 网关一帧 = 一行 `data:`。
- **工具 `id` 靠 Map 按 `index` 复用** —— 只有首个分片带 `id`。
- **`function.name` 只在非空时更新** —— 后续分片带 `""`（不是 `undefined`），直接覆盖会导致 `unknown tool ""`。
- **残缺工具参数报 `max-tokens` 而不是 `tool-calls`** —— 报 `tool-calls` 会让 harness 执行半截 JSON 并把脏参数写进会话历史，报 `max-tokens` 才会丢弃并重试。
- **`readWithIdleTimeout` 的 abort 分支也要 reject** —— 只清定时器会让 `Promise.race` 永远悬空，generator 既不产出也不返回。
- **provider 注册冲突只记日志、不抛错** —— 冲突意味着用户还没迁移旧配置，此时抛错会让 dsh 起不来，把一个可用环境变成完全不可用。

---

## 延伸阅读

- [轮级聚合：让一次对话只有一个 RequestID](docs/turn-level-aggregation.md) —— 为什么要按现在的方式序列化请求
- [轮级聚合键的跨语言验证工具](tools/turnkey-verify/README.md) —— 用上游真实 Go 实现验证适配器产出
- [方案与调研记录（2026-09-15）](docs/handoff-20260915-gateway-plugin.md) —— 设计取舍与上游能力调研

---

## 许可

MIT
