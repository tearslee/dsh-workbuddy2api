/**
 * 账号开关：重命名 `auths/` 下的凭证文件，实现「只用某一个账号 / 恢复全部轮换」。
 *
 * ## 为什么用文件改名，而不是让网关开个接口
 *
 * 网关（upstream Sliverkiss/workbuddy2api）只暴露四个路由 —— `POST /v1/chat/completions`、
 * `GET /v1/models`、`GET /status`、`GET /healthz`（`internal/server/handler.go:101-104`），
 * 没有任何账号管理端点，config 里也没有账号级开关（账号优先级完全由池内三因子加权决定）。
 * 但它加载账号的 glob 是 `workbuddy*.json`（`internal/auth/auth.go:328`），
 * 因此把文件改名成 `*.json.disabled` 就等于「该账号对网关不存在」。
 * 零 Go 侧改动 → 上游升级零冲突；代价是每次切换要重启网关（见下）。
 *
 * ## 状态即文件
 *
 * 不另存「当前选择」：目录里恰好一个 `workbuddy*.json` 就是单选模式，全部启用就是
 * 自动轮换模式。重启 dsh、换机器、用户手工改名，读出来的状态都一致，不存在两边不同步。
 *
 * ## 顺序约束（违反可能静默失效）
 *
 * 1. **先停网关 → 再改名 → 后启网关**。网关运行中会因 token 临近过期调用
 *    `Auth.SaveAtomic()`，它按内存里的旧 `FilePath` 写回 —— 可能把刚改名的文件
 *    **重新创建**出来，禁用无声失效（表现为「切换看起来成功，一分钟后自己变回两个号」）。
 *    编排由 `index.ts` 的 `/wb2api-account` 负责，本模块只做纯文件操作。
 *
 *    > 补充（2026-09-18 实测）：较新的网关（含本插件 Release 提供的二进制）已加入
 *    > `internal/pool/watch.go` 的 auths 目录热加载（每 5s 轮询目录指纹），改名本身
 *    > 会被自动感知。但**停→改→启仍然保留**：它对旧版自编译二进制是必需的，
 *    > 对新版也消除了「改名与 token 刷新竞态」的那个窗口期。代价只是一次 1~3 秒重启。
 * 2. **复用外部网关（`state === 'external'`）时禁止改名**。那种情形进程不归插件管、
 *    停不掉，必然命中第 1 条。
 * 3. **只改名、从不删除**。恢复 = 把 `*.json.disabled` 改回 `*.json`。
 *
 * @module dsh-workbuddy2api/accounts
 */

import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { GatewayPluginConfig } from './config.js'

/**
 * 禁用后缀。刻意用 `.json.disabled` 而不是 `*.bak` / 挪到别的目录：
 * 后缀一变文件名就不再匹配网关的 `workbuddy*.json` glob，同时**原文件名完整保留**
 * 在中间段里，恢复时无需任何映射表。
 */
export const DISABLED_SUFFIX = '.disabled'

/** 切换目标：`auto` = 全部账号参与轮换；`single` = 只启用指定 uid。 */
export type AccountSelection = { kind: 'auto' } | { kind: 'single'; uid: string }

/** 一个凭证文件对应的账号（信息全部来自文件本身，不含任何 token）。 */
export interface AuthAccount {
  /** `account.uid`。 */
  uid: string
  /** `account.nickname`，缺失为空串。 */
  nickname: string
  /** 归一化域：`auth.realm`，为空时按 `auth.domain` 推断（与网关 `Auth.Realm()` 同口径）。 */
  realm: string
  /** `auth.domain`。 */
  domain: string
  /** 凭证文件绝对路径。 */
  file: string
  /** 是否对网关可见（文件名匹配 `workbuddy*.json`）。 */
  enabled: boolean
}

/** 一次改名动作（用于向用户回报改了什么）。 */
export interface AccountRename {
  from: string
  to: string
  /** 改完之后是否启用。 */
  enabled: boolean
}

/** 切换结果。 */
export interface SelectionResult {
  renamed: AccountRename[]
  /** 切换后的完整账号清单（已重新扫描）。 */
  accounts: AuthAccount[]
}

/** 判断某个账号在给定目标下是否应当启用。 */
export function shouldEnable(selection: AccountSelection, account: Pick<AuthAccount, 'uid'>): boolean {
  return selection.kind === 'auto' || account.uid === selection.uid
}

/**
 * 纯计算：列出为达成目标需要改名的文件（不落盘）。
 *
 * 与 {@link AccountStore.applySelection} 共用同一份校验，因此命令层可以先用它
 * **判断「是否真的需要动网关」** —— 已经处于目标状态时返回空数组，调用方据此跳过
 * 停/启网关（避免一次无谓的请求中断）。全部校验（重复 uid、uid 不存在、目标文件已存在）
 * 都在这里，执行侧只负责 renameSync。
 */
export function planRenames(accounts: AuthAccount[], selection: AccountSelection): AccountRename[] {
  // 同一 uid 两份文件（一启用一禁用）无法表达「只启用它」，必须让用户先手工清理：
  // 强行处理会同时产生 enable 与 disable 两个互相矛盾的改名动作。
  const seen = new Map<string, AuthAccount[]>()
  for (const account of accounts) {
    const bucket = seen.get(account.uid)
    if (bucket === undefined) seen.set(account.uid, [account])
    else bucket.push(account)
  }
  for (const [uid, bucket] of seen) {
    if (bucket.length > 1) {
      throw new Error(
        `uid ${uid} 同时存在 ${bucket.length} 份凭证文件（${bucket.map(a => basename(a.file)).join('、')}），`
        + '请先手工清理，再执行切换。',
      )
    }
  }

  if (selection.kind === 'single' && !seen.has(selection.uid)) {
    throw new Error(`未找到 uid=${selection.uid} 的凭证文件。`)
  }

  const plan: AccountRename[] = []
  for (const account of accounts) {
    const target = shouldEnable(selection, account)
    if (account.enabled === target) continue
    const to = target ? account.file.slice(0, -DISABLED_SUFFIX.length) : account.file + DISABLED_SUFFIX
    if (existsSync(to)) {
      throw new Error(`目标文件已存在，拒绝覆盖：${to}`)
    }
    plan.push({ from: account.file, to, enabled: target })
  }
  return plan
}

/** 日志接口（与 cordis logger 的最小交集，与 gateway-supervisor 保持一致）。 */
export interface AccountLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface AccountStoreOptions {
  config: GatewayPluginConfig
  logger: AccountLogger
}

/** 凭证文件的 JSON 形状（只声明本模块读取的字段）。 */
interface RawAuthFile {
  auth?: { domain?: unknown; realm?: unknown }
  account?: { uid?: unknown; nickname?: unknown }
}

/**
 * 按 `auth.domain` 推断归一化域。
 *
 * 与网关 `internal/auth/auth.go` 的 `isGlobalDomain` 同口径：裸域 `workbuddy.ai`
 * 及其任意子域算 global，其余（`copilot.tencent.com` / `www.codebuddy.cn` 等）算 cn。
 */
function inferRealm(domain: string): string {
  const d = domain.toLowerCase()
  return d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

/** 解析凭证文件里的账号标识；拿不到 uid 视为不可用文件。 */
function readAccount(parsed: unknown): Omit<AuthAccount, 'file' | 'enabled'> | undefined {
  const raw = (parsed ?? {}) as RawAuthFile
  const uid = typeof raw.account?.uid === 'string' ? raw.account.uid : ''
  if (uid === '') return undefined
  const nickname = typeof raw.account?.nickname === 'string' ? raw.account.nickname : ''
  const domain = typeof raw.auth?.domain === 'string' ? raw.auth.domain : ''
  const stored = typeof raw.auth?.realm === 'string' ? raw.auth.realm : ''
  return { uid, nickname, realm: stored !== '' ? stored : inferRealm(domain), domain }
}

/**
 * 账号文件开关。
 *
 * 只做三件事：定位目录、列出账号、改文件名。不含任何网关进程操作 ——
 * 「停网关 → 改名 → 启网关」的编排属于命令层，本类保持可单测的纯文件语义。
 */
export class AccountStore {
  constructor(private readonly options: AccountStoreOptions) {}

  /**
   * 定位网关实际使用的 auths 目录。
   *
   * 基准目录的选取必须与 `GatewaySupervisor.resolveWorkingDir()` **完全一致** ——
   * 否则本命令会去改一个网关根本不读的目录，且不报任何错（切换"成功"了但账号没变）。
   * 顺序：`workingDir` → `repoPath` → 插件运行目录 `~/.dsh/wb2api/`（`/wb2api-setup`
   * 下载二进制时把凭证放在这里）→ 当前工作目录。
   *
   * 目录名本身优先读网关 `config.json` 的 `auth_dir`（相对基准目录解析），
   * 缺失或解析失败才回退 `./auths`。刻意不硬编码：用户改了 `auth_dir` 而插件仍去改
   * 默认目录的话，会「改了个没用的地方」且不报错。
   */
  authDir(): string {
    const { repoPath, workingDir } = this.options.config
    const runtime = join(homedir(), '.dsh', 'wb2api')
    const base = workingDir !== ''
      ? workingDir
      : repoPath !== ''
        ? repoPath
        : existsSync(join(runtime, 'config.json')) ? runtime : ''
    // config.json 的读取位置与基准目录一致：两处都看同一个文件，避免"目录用 A、配置读 B"。
    const configRoot = base !== '' ? base : repoPath
    let authDir = './auths'
    if (configRoot !== '') {
      const configFile = join(configRoot, 'config.json')
      try {
        if (existsSync(configFile)) {
          const parsed = JSON.parse(readFileSync(configFile, 'utf8')) as { auth_dir?: unknown }
          if (typeof parsed.auth_dir === 'string' && parsed.auth_dir !== '') authDir = parsed.auth_dir
        }
      } catch {
        // 忽略：网关 config.json 不存在或不是 JSON 时按默认 ./auths 处理。
      }
    }
    return base === '' ? resolve(authDir) : resolve(base, authDir)
  }

  /**
   * 扫描凭证文件清单。
   *
   * 排序：启用的在前，其次按 uid 字典序 —— 与命令输出的序号稳定对应，
   * 否则「序号 2」在两次调用之间可能指向不同账号。
   */
  list(): AuthAccount[] {
    const dir = this.authDir()
    if (!existsSync(dir)) return []
    const out: AuthAccount[] = []
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('workbuddy')) continue
      const enabled = name.endsWith('.json')
      const disabled = !enabled && name.endsWith(`.json${DISABLED_SUFFIX}`)
      if (!enabled && !disabled) continue
      const file = join(dir, name)
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        this.options.logger.warn(
          `[workbuddy2api] 凭证文件解析失败，已跳过：${name}（${error instanceof Error ? error.message : String(error)}）`,
        )
        continue
      }
      const account = readAccount(parsed)
      if (account === undefined) {
        this.options.logger.warn(`[workbuddy2api] 凭证文件缺少 account.uid，已跳过：${name}`)
        continue
      }
      out.push({ ...account, file, enabled })
    }
    out.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.uid.localeCompare(b.uid))
    return out
  }

  /** 当前启用（对网关可见）的账号数。 */
  enabledCount(): number {
    return this.list().filter(a => a.enabled).length
  }

  /**
   * 应用切换目标：把目录改成「只有目标可见」或「全部可见」。
   *
   * 幂等：已经处于目标状态的文件不会被改名（因此 `renamed` 可能为空数组，
   * 调用方据此可以跳过重启网关）。
   *
   * 调用方**必须**已经停掉网关（见模块头「顺序约束」）。
   *
   * @param selection - `auto` 或指定 uid。
   * @returns 改名清单 + 切换后的账号清单。
   * @throws 指定 uid 不存在、同一 uid 有多份凭证文件、目标文件已存在时抛错。
   */
  applySelection(selection: AccountSelection): SelectionResult {
    const plan = planRenames(this.list(), selection)
    for (const item of plan) {
      renameSync(item.from, item.to)
      this.options.logger.info(
        `[workbuddy2api] 账号文件${item.enabled ? '启用' : '禁用'}：${basename(item.from)} → ${basename(item.to)}`,
      )
    }
    return { renamed: plan, accounts: this.list() }
  }
}

/**
 * 把命令参数解析成切换目标。
 *
 * 支持三种写法：`auto` / 序号（按 {@link AccountStore.list} 的稳定排序，从 1 起）/ uid 前缀。
 * `auto` 大小写不敏感；序号与 uid 前缀都要求**唯一命中**，模糊命中会抛错并列出候选，
 * 避免「以为切了 A 其实切了 B」。
 */
export function parseAccountSelector(accounts: AuthAccount[], raw: string): AccountSelection {
  const input = raw.trim()
  if (input === '') throw new Error('缺少参数。用法：/wb2api-account auto | <序号> | <uid 前缀>')
  if (input.toLowerCase() === 'auto') return { kind: 'auto' }

  if (/^\d+$/.test(input)) {
    const index = Number(input)
    const target = accounts[index - 1]
    if (index < 1 || target === undefined) {
      throw new Error(`序号 ${input} 超出范围（当前 ${accounts.length} 个账号）。`)
    }
    return { kind: 'single', uid: target.uid }
  }

  const matches = accounts.filter(a => a.uid.startsWith(input))
  if (matches.length === 0) {
    throw new Error(`没有 uid 以 «${input}» 开头的账号。`)
  }
  if (matches.length > 1) {
    throw new Error(
      `uid 前缀 «${input}» 命中 ${matches.length} 个账号，请写长一点：\n  `
      + matches.map(a => a.uid).join('\n  '),
    )
  }
  return { kind: 'single', uid: matches[0]!.uid }
}
