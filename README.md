# dsh-workbuddy2api

**把 [workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) 网关接进 [DeepSeek Harness（dsh）](https://www.npmjs.com/package/@deepseek-ai/dsh) 的插件。**

装上之后：

- **dsh 启动时自动拉起网关，退出时自动回收**；端口上已有健康网关在跑则直接复用，不重复拉起，也不会去杀别人的进程。
- **模型目录自动同步** —— 模型列表、上下文窗口、输出上限、思考档位全部从网关 `GET /v1/models` 实时读取，不必再手写 `settings.yaml` 里的模型元数据。
- **6 条管理命令**：`/wb2api-setup` · `/wb2api-status` · `/wb2api-start` · `/wb2api-restart` · `/wb2api-login` · `/wb2api-account`。
- **一条命令完成安装**：`/wb2api-setup` 会取回网关可执行文件（校验 SHA256）、准备运行目录、引导登录、启动网关并同步模型 —— **不需要装 Go，也不需要 python3 / bash**。

插件本身很薄：协议适配、账号池、加权选号、分级熔断、定时任务、登录与 token 刷新**全部留在 Go 网关侧**。它只负责两件事 —— 进程生命周期，和模型目录自动化。

---

## 它解决什么

直接用手工配置把 workbuddy2api 接进 dsh（在 `~/.dsh/settings.yaml` 里写 `llm-pi-ai.providers.workbuddy2api`）也能用，但有几处手工负担：

| 问题 | 手工接法 | 本插件 |
|---|---|---|
| **模型元数据** | 每个模型的 `contextWindow` / `maxTokens` / `reasoningEfforts` / `input` 全手抄；网关增删模型必须手改文件 | 运行时读 `/v1/models` 自动映射 |
| **进程管理** | dsh 启动前必须另行常驻 `wb2a-server.exe`，退出也不联动 | 插件托管子进程，生命周期绑定 dsh |
| **获取网关二进制** | 装 Go 工具链 → `git clone` 上游 → `go build` | `/wb2api-setup` 自动下载 + SHA256 校验 |
| **账号登录** | 上游 `login.sh` 需要 **bash + python3**（Windows 上基本劝退） | 插件内置同款 OAuth 流程，纯 Node 实现 |
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

2. **一个 WorkBuddy 账号**（国内外账号体系相互独立，选你有的那个）。

3. **网关二进制** —— **不用自己准备**，`/wb2api-setup` 会自动下载并校验。

---

## 安装

### 方式一：一条命令直装（推荐）

**不需要先下载文件** —— pnpm 支持直接以 Release 的 tarball URL 作为依赖（已实测：装出来是真实目录、非 `link:`）：

```bash
dsh plugin --profile web add https://github.com/tearslee/dsh-workbuddy2api/releases/download/v0.3.0/dsh-workbuddy2api-0.3.0.tgz
```

升级时把 URL 里的版本号换掉即可。

### 方式二：先下载再本地安装

在 [Releases](https://github.com/tearslee/dsh-workbuddy2api/releases/latest) 下载 `dsh-workbuddy2api-<版本>.tgz`，然后：

```bash
dsh plugin --profile web add file:/绝对路径/dsh-workbuddy2api-0.3.0.tgz
```

### 方式三：从源码安装

```bash
git clone https://github.com/tearslee/dsh-workbuddy2api
cd dsh-workbuddy2api
npm install
node node_modules/typescript/bin/tsc -p tsconfig.json   # 必须先构建出 lib/
npm pack --pack-destination dist
dsh plugin --profile web add file:./dist/dsh-workbuddy2api-0.3.0.tgz
```

> **不要用 `dsh plugin install <源码目录>`**：pnpm 会写成 `link:` 依赖，而 Windows 上工具进程创建的 junction 不可遍历，会导致 pnpm 全面失效。用 `npm pack` / `pnpm pack` 出的 tarball（解包成真实目录）可规避。

> **关于 npm registry**：本包**尚未发布到 npm**，因此 `dsh plugin add dsh-workbuddy2api` 会 404 —— 请用上面三种方式之一。发布后会更新这里。

**装完重启 dsh**，然后在 dsh 里执行：

```
/wb2api-setup
```

它会依次：① 定位或下载网关可执行文件（校验 SHA256）→ ② 准备运行目录（生成 `config.json`，随机 `api_key`，仅监听 `127.0.0.1`）→ ③ 引导你完成账号登录 → ④ 启动网关并同步模型目录。每一步的结果都会逐条汇报，失败会停在那一步并说明原因。

首次执行会问你要登录**国内版还是国际版**，也可直接指定：`/wb2api-setup cn` 或 `/wb2api-setup global`。

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
| `workingDir` | `''` | 子进程工作目录；为空时取 `repoPath`，再取插件运行目录 `~/.dsh/wb2api/` |
| `listenPort` | `7863` | 仅用于端口占用判定与状态展示 |
| `autoStart` | `true` | dsh 启动时是否自动拉起网关 |
| `autoDownloadBinary` | `false` | dsh 启动时若缺二进制是否**自动下载**（见下） |
| `binaryReleaseRepo` | `tearslee/dsh-workbuddy2api` | 预编译二进制的发布仓库 |
| `binaryReleaseBase` | `''` | 覆盖下载根地址（自建镜像 / 钉版本） |
| `defaultRealm` | `''` | 登录默认域（`cn` / `global`）；为空则每次询问 |
| `realmPrefixPolicy` | `strip-cn` | 模型 id 的前缀策略，见下 |
| `modelsTtlSeconds` | `600` | `/v1/models` 缓存 TTL |
| `requestTimeoutSeconds` | `600` | 单次请求整体超时 |
| `idleTimeoutSeconds` | `300` | SSE 帧间空闲超时（超时报可重试的 `TIMEOUT`） |
| `firstTokenTimeoutSeconds` | `120` | 首个 token 等待超时 |
| `healthTimeoutSeconds` | `3` | 单次探活超时 |
| `graceMs` | `5000` | 子进程优雅退出宽限期 |
| `crashRestartLimit` | `3` | 崩溃自动重启上限 |
| `env` | `{}` | 传给网关子进程的显式环境变量 |

### 网关二进制与运行目录

`/wb2api-setup` 会把东西装在这些位置（都在插件自己的目录下，**不碰你的其它文件**）：

| 用途 | 位置 |
|---|---|
| 可执行文件 | `~/.dsh/wb2api/bin/wb2a-server[.exe]` |
| 配置文件 | `~/.dsh/wb2api/config.json` |
| 账号凭证 | `~/.dsh/wb2api/auths/` |
| 池状态 | `~/.dsh/wb2api/data/state.json` |

产物来自本仓库的 [Releases](https://github.com/tearslee/dsh-workbuddy2api/releases)（GitHub Actions 从**上游源码原样交叉编译**，未改一行上游代码），下载后会与 `SHA256SUMS.txt` 比对，**不匹配就拒绝安装**。

生成的 `config.json` 有两处刻意选择：

- **只监听 `127.0.0.1`**（上游示例的 `:7863` 会绑 `0.0.0.0`，等于把带账号池的网关暴露到局域网）；
- **随机 `api_key`**（网关在 `api_key` 为空时**完全不鉴权**，而 `/status` 会暴露账号与积分）。

已存在的 `config.json` **绝不会被覆盖** —— 你改了池参数、冷却策略或 `auth_dir` 都会被保留。

### `autoDownloadBinary` 为什么默认关

隐式时机的联网下载在离线/内网环境只会刷报错，而用户从未要求联网。**显式执行 `/wb2api-setup` 时无视该开关**（那是明确意图）。想彻底零步骤的话把它设为 `true`。

### `apiKey` 的解析顺序

1. dsh 凭据库（`~/.dsh/.credentials.yaml` 的 `refs.WORKBUDDY2API_API_KEY`）
2. 同名环境变量
3. 网关自己的 `config.json` 里的 `api_key`（含插件自动生成的那份）

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
| `/wb2api-setup [cn\|global]` | **一键就绪**：准备可执行文件、运行目录、账号，启动网关并同步模型目录 |
| `/wb2api-status` | 网关状态、账号可用性（`healthy/total`）、各 realm 可服务性、模型数量、账号清单（启用/禁用 + 积分/冷却） |
| `/wb2api-start` | 启动网关（幂等：已在运行则直接复用） |
| `/wb2api-restart` | 重启网关并刷新模型目录 |
| `/wb2api-login [cn\|global]` | 登录一个 WorkBuddy 账号（浏览器授权，凭证写入 `auths/`） |
| `/wb2api-account` | 查看/切换网关使用的账号（不带参数时弹出可点选列表，见下） |

### 关于「复用外部网关」

启动前插件会先探 `GET /healthz`（**该端点无需鉴权**）：

- **端口上已有健康网关** → 直接复用，状态记为 `external`，插件**不会**再拉一个进程。这正是「以前手工常驻了一个 wb2api」的迁移场景：装完插件一切照旧可用，但那个进程仍归你管 —— dsh 退出时**不会**去杀它（插件不杀自己没启动的进程）。
- **端口空闲** → 解析可执行文件并 spawn，此后它的生命周期归 dsh，`dispose` 时一并回收。
- **端口被非网关程序占用** → 明确报错，而不是静默失败。

所以：**想让网关真正由 dsh 托管，先停掉你手工启动的那个进程**，再重启 dsh。`/wb2api-status` 的 `状态:` 一行会告诉你当前是哪种情形。

### 登录

`/wb2api-login` 会向 WorkBuddy 申请一条授权链接并弹窗给你打开；你在浏览器里完成授权后，它自动取回凭证、写入 `auths/` 并重启网关加载。

> 这套流程与上游 `login.sh` + `cmd/login` **同款端点、同款凭证格式**（插件用 Node 复刻，因此**不需要 bash 与 python3**）。国内版会顺手做一次每日签到，失败不影响登录。

不带参数时会问你要登录国内版还是国际版；也可直接写 `/wb2api-login cn` 或 `/wb2api-login global`。想固定下来就设配置项 `defaultRealm`。

### 切换账号

`/wb2api-account` 决定**网关能看见哪些账号**。不带参数时弹出可点选列表（当前选择 + 每个账号的昵称、realm、积分、冷却状态），带参数则直接切：

```
/wb2api-account auto            # 恢复全部账号参与加权轮换（默认）
/wb2api-account 2               # 只启用列表里第 2 个账号
/wb2api-account oneid_3000      # 只启用 uid 以该前缀开头的账号（前缀必须唯一命中）
```

**机制：重命名凭证文件，不改网关一行代码。** 网关只加载匹配 `workbuddy*.json` 的文件（`internal/auth/auth.go` 的 `AuthFileGlob`），因此把其余文件改名成 `workbuddy-<uid>.json.disabled` 就等于「它们不存在」。上游升级零冲突。**只改名、从不删除**，`auto` 即把后缀去掉 —— 所以状态即文件：重启 dsh、换机器、用户手工改名，读出来的选择都一致。

**为什么走「停网关 → 改名 → 启网关」**（所以命令不用 `supervisor.restart()`）：网关运行中会因 token 临近过期把凭证**原子写回**，落点取自它内存里的旧路径 —— 可能把刚改名的文件重新创建出来，于是切换「看着成功，一分钟后又变回去」。先停进程，写回就不会发生。

> 较新的网关（含本插件 Release 的二进制）已加入 `auths/` 目录热加载（每 5 秒轮询），改名本身也会被感知；但上面这个顺序仍然保留 —— 它对旧版自编译二进制是必需的，对新版也消除了改名与 token 刷新的竞态窗口。代价只是一次 1~3 秒重启。

**复用外部网关时不支持切换。** 此时进程不归插件管（`/wb2api-status` 的 `状态:` 一行显示 `复用外部已运行的网关`），停不掉 ⇒ 必然踩上面那条。命令会直接拒绝并提示：先停掉那个进程让插件托管，或改用 `/wb2api-login` 加号。

**取舍与风险**：

- 被禁用的账号**不参与轮换，也不再刷新 token**。长期禁用后其 `refresh_token` 可能失效；恢复时若报会话失效，重跑 `/wb2api-login` 即可（同一 uid 覆盖同一份凭证文件）。
- 被禁用的账号不再出现在网关 `/status` 里，因此列表里它的积分显示为「未知」（昵称与 realm 仍从文件读出）。
- 「只启用一个号」**不等于**「优先用这个号」：池里只剩它一个，网关无从回退。它正在冷却时请求可能 429 或 503 —— 这是「没有别的号可换」的必然表现，不是切换失败。要恢复自动兜底就 `/wb2api-account auto`。
- 切换只影响**网关的账号集**，与你在 WorkBuddy 桌面端登录的是哪个账号无关（那是另一条路线，见 [Python 版 codebuddy2api](https://github.com/ShouZhuo0413/codebuddy2api)）。

---

## 已知限制

- **窗口/输出上限是「上游实际值 + 本地估计」的混合。** 网关对 `context_length` 走四级查找链：上游动态值权威 → 静态种子表 → `model.json` 缓存 → models.dev 按需拉取；**全未命中时兜底 1M**。因此冷门模型的窗口可能是兜底值而非真实值。`max_output_tokens` 同理，未收录时网关**不下发该键**，此时插件不声明 `defaultMaxTokens`，由网关自行决定。
- **无账号时网关「启动 ≠ 可用」。** 进程起来但 `/healthz` 报 `healthy: 0`，插件会把状态标为「运行中（无可用账号）」而不是假装成功。
- **切换账号仍会重启网关。** 切换靠重命名凭证文件实现（见上）。较新的网关有 5 秒热加载能自行感知，本插件仍走一次重启以确保新旧二进制行为一致，代价是中断正在进行的请求 1~3 秒。
- **预编译产物来自本仓库的 CI，可能与上游最新提交有延迟。** 想紧跟上游就自行 `go build`（把 `binaryPath` 指向你的产物，插件不会覆盖它）。上游若改动凭证格式或路由，本插件的适配可能滞后。
- **模型不出现在「设置 → 模型」页，只在聊天窗口的模型选择器里。** 这是 dsh 的既定设计，不是本插件的缺陷：设置页本质是**配置文件编辑器**，`dsh-client-ui-settings-models` 只认 `llm-deepseek` 与 `llm-pi-ai` 两个 settings namespace，其余不渲染 provider 行；而本插件的 provider 是**代码注册的运行时路由**，模型目录来自网关 `/v1/models`，本就不属于那个界面管辖。要确认模型可用：看聊天窗口的模型选择器，或执行 `/wb2api-status`。

---

## 常见问题

### 网关起不来，日志只有 `load config: read config: open config.json: ...`

网关在**找不到 `config.json` 时直接退出**（上游那段「缺配置就用默认值+环境变量」的兜底因为 `os.IsNotExist` 判不透包装错误而永远进不去 —— 见「为什么有几处写法看起来多余」）。

先跑 `/wb2api-setup`：它会补建运行目录并生成配置。若你希望自己管这份目录，就把插件配置的 `repoPath` 指到网关源码目录（那里有你的 `config.json`），插件即不会再碰 `~/.dsh/wb2api/`。

### 网关起来了但 `/healthz` 一直是 `healthy: 0`

进程没问题，是**没有可用账号**。执行 `/wb2api-login` 登录一个账号；若已有账号，用 `/wb2api-status` 看它是不是正在冷却（单一账号时冷却就等于全部请求失败，见下）。

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

- 本插件**不包含、不转发 workbuddy2api 的任何源码**。网关源码始终来自上游仓库。
- 本仓库的 [Releases](https://github.com/tearslee/dsh-workbuddy2api/releases) 提供**由本仓库 CI 从上游源码原样交叉编译**的可执行文件（构建过程见 `.github/workflows/release-binaries.yml`：先断言上游工作区未被修改，再校验产物内嵌的 `vcs.modified=false`）。上游不提供预编译产物，这些二进制是为了让用户不必自装 Go 工具链；**许可证与免责声明仍归上游**。介意第三方构建的话，请自行 `go build` 并把 `binaryPath` 指向你的产物。
- workbuddy2api 的许可与免责声明由其自身条款约束，使用前请自行阅读。
- 本插件以 MIT 许可发布，与上游无隶属关系。

---

## 开发

```bash
npm install
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
| `src/accounts.ts` | 账号开关：扫描 `auths/` 凭证文件、按切换目标重命名（停/启网关的编排在 `index.ts`） |
| `src/gateway-binary.ts` | 预编译二进制的下载、SHA256 校验、运行目录（`config.json`）准备 |
| `src/login.ts` | 用 Node 复刻上游 OAuth 登录（取授权链接 → 轮询 token → 落盘凭证） |
| `src/setup.ts` | `/wb2api-setup` 的编排与逐步骤汇报 |
| `src/zip.ts` | 极简 ZIP 读取（stored/deflate），避免引入解压依赖 |
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
- **切换账号的顺序必须是「停 → 改名 → 启」** —— 网关运行中会用内存里的旧 `FilePath` 把凭证原子写回，改名会被它撤销。所以 `/wb2api-account` 刻意不用 `supervisor.restart()`（它无法在停与启之间插一步动作）；改名本身失败时也会把网关拉回来，不把环境留在「网关已停」。
- **自动下载必须同时生成 `config.json`** —— 上游 `main.go` 写了「配置不存在就用默认值+环境变量」的兜底，但它用 `os.IsNotExist()` 判断一个**已被 `fmt.Errorf("read config: %w", …)` 包装过**的错误，永远为假，于是进程直接 `log.Fatalf` 退出（实测：二进制放进空目录执行，4 秒内退出，只留一行 `load config: read config: open config.json: …`）。所以插件必须自己写这份配置。
- **生成的配置只监听 `127.0.0.1` 且必带随机 `api_key`** —— 上游示例的 `:7863` 会绑 `0.0.0.0`（实测 `netstat` 可见），而网关在 `api_key` 为空时**完全不鉴权**，`/status` 会暴露账号与积分。
- **装二进制前必须校验 SHA256，且拿不到校验和就拒绝安装** —— 下载的是**会被执行的文件**。校验和清单缺失时"下都下了就装"等于没有校验。
- **`auths/` 目录必须先于网关启动而存在** —— 网关只在启动时探测该目录，不可读就永久跳过 `auths` 热加载（实测日志：`[watch] auths 目录 ./auths 不可读，跳过热加载监听（加账号后需手动重启）`），之后新增账号不会再被自动加载。

---

## 延伸阅读

- [轮级聚合：让一次对话只有一个 RequestID](docs/turn-level-aggregation.md) —— 为什么要按现在的方式序列化请求
- [轮级聚合键的跨语言验证工具](tools/turnkey-verify/README.md) —— 用上游真实 Go 实现验证适配器产出
- [方案与调研记录（2026-09-15）](docs/handoff-20260915-gateway-plugin.md) —— 设计取舍与上游能力调研

---

## 许可

MIT
