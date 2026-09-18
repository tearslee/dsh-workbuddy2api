/**
 * 账号登录：用 Node 复刻上游 `login.sh` + `cmd/login` 的 OAuth 流程。
 *
 * ## 为什么要在插件里重做一遍
 *
 * 上游的登录路径是 `login.sh`（bash）+ `cmd/login`（Go 二进制）+ **`python3`**（解析 token、
 * 落盘 auth 文件、签到）。对「只想在 dsh 里用起来」的人，这条路的实际门槛是：
 * 得有 bash、得有 python3、得先 `go build` 出 `login` 工具 —— Windows 上基本劝退。
 *
 * 但这个流程本身很朴素：**取 state → 浏览器授权 → 轮询取 token → 落盘**，没有任何
 * 终端交互（不需要 TTY，也不需要本地回调端口）。因此可以原样用 fetch 复刻，
 * 让「装完插件 → 登录」不再依赖任何外部运行时。
 *
 * ## 与上游的一致性
 *
 * 端点、请求头、`{code,msg,data}` 信封与字段名全部对齐
 * `workbuddy2api/cmd/login/main.go`（`realmConfig` / `commonHeaders` / `doJSON` /
 * `buildLoginOutput`），落盘结构对齐 `login.sh` 的 heredoc：
 *
 * ```json
 * { "account": { "uid", "enterpriseId", "nickname" },
 *   "auth":    { "accessToken", "refreshToken", "expiresAt", "domain", "realm" } }
 * ```
 *
 * `expiresAt` 是 **Unix 秒**（网关契约 `internal/auth/auth.go` 的 `ExpiresAt int64`），
 * 不是毫秒 —— 写错单位会让网关判成「永不过期」而永不刷新。
 *
 * @module dsh-workbuddy2api/login
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** realm 取值。 */
export type Realm = 'cn' | 'global'

/** 单个 realm 的上游端点。 */
export interface RealmEndpoints {
  /** API 基址（state / token / account 端点都挂在这里）。 */
  base: string
  /** `Origin` / `Referer` 头用的站点源。 */
  origin: string
  /** 签到接口所在的站点源（仅 CN 有；global 为 undefined 表示不签到）。 */
  checkinBase?: string
}

/**
 * 与上游 `realmConfig` 同表。
 *
 * 注意 CN 的 base 与 origin **不同域**（`copilot.tencent.com` vs `codebuddy.cn`），
 * 这是上游实测行为，不要「顺手统一」成同域 —— 上游会校验 Origin。
 */
export function realmEndpoints(realm: Realm): RealmEndpoints {
  return realm === 'global'
    ? { base: 'https://www.workbuddy.ai', origin: 'https://www.workbuddy.ai' }
    : { base: 'https://copilot.tencent.com', origin: 'https://www.codebuddy.cn', checkinBase: 'https://www.codebuddy.cn' }
}

/** 上游 `clientUA`：登录端点会看 UA，不要改成插件的标识。 */
export const LOGIN_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** 上游 `commonHeaders`。 */
export function loginHeaders(origin: string, token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': LOGIN_USER_AGENT,
    ...token !== undefined && token !== '' ? { Authorization: `Bearer ${token}` } : {},
  }
}

/** 上游响应信封。 */
interface Envelope<T> {
  code?: number
  msg?: string
  data?: T
}

/** 登录尚未完成（用户在浏览器里还没点完）—— 可重试，不是故障。 */
export class LoginPendingError extends Error {
  constructor(message = '登录尚未完成：请先在浏览器里完成授权，再重试。') {
    super(message)
    this.name = 'LoginPendingError'
  }
}

/** 把交互式选域的一行输入归一化（与上游 `resolveRealmInput` 同规则）。 */
export function resolveRealmInput(input: string): Realm | undefined {
  switch (input.trim().toLowerCase()) {
    case '':
    case '1':
    case 'cn':
      return 'cn'
    case '2':
    case 'global':
      return 'global'
    default:
      return undefined
  }
}

/** `/wb2api-login` 与 `/wb2api-setup` 共用的参数解析：`[cn|global]`。 */
export function parseRealmArg(raw: string): Realm | undefined {
  const input = raw.trim()
  if (input === '') return undefined
  return resolveRealmInput(input)
}

/** 归一化域（与网关 `Auth.Realm()` 同口径：显式 realm 优先，其次按 domain 后缀）。 */
export function inferRealm(explicit: string | undefined, domain: string): Realm {
  if (explicit === 'global' || explicit === 'cn') return explicit
  const d = domain.toLowerCase()
  return d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

/** `state` 端点返回。 */
export interface AuthState {
  state: string
  authUrl: string
}

/** `token` 端点返回。 */
export interface TokenBundle {
  accessToken: string
  refreshToken: string
  expiresIn: number
  domain: string
}

/** `login/account` 端点返回。 */
export interface AccountInfo {
  uid: string
  enterpriseId: string
  nickname: string
}

/** 一次成功登录的全部产物。 */
export interface LoginResult {
  realm: Realm
  token: TokenBundle
  account: AccountInfo
}

/** 登录所需的最小 fetch 形状（便于测试注入）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 登录客户端：三个上游调用 + 一个可选的签到。 */
export class LoginClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  /**
   * 发一次请求并拆信封。
   *
   * `{code,msg,data}` 中 `code !== 0` 表示业务失败；上游在「登录未完成」时正是这么回的，
   * 因此这里把 HTTP 4xx/5xx 与业务 code 都归类：**能确定是 pending 的抛
   * {@link LoginPendingError}**（可重试），其余抛普通错误（真故障）。
   */
  private async call<T>(
    url: string,
    realm: Realm,
    init: { method: string; body?: string; token?: string },
  ): Promise<T> {
    const { origin } = realmEndpoints(realm)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: loginHeaders(origin, init.token),
        ...init.body !== undefined ? { body: init.body } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new Error(`请求 ${url} 失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const text = await response.text().catch(() => '')
    let envelope: Envelope<T>
    try {
      envelope = JSON.parse(text) as Envelope<T>
    } catch {
      throw new Error(`上游返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }

    if (envelope.code !== undefined && envelope.code !== 0) {
      const message = `code=${envelope.code} msg=${envelope.msg ?? ''}`
      // 上游「登录未完成」走 4xx + 非 0 code（实测 msg="login ing"）。
      if (response.status >= 400 && response.status < 500) throw new LoginPendingError(`登录尚未完成（${message}）`)
      throw new Error(message)
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}：${text.slice(0, 200)}`)
    }
    if (envelope.data === undefined) {
      throw new Error(`上游响应缺少 data 字段：${text.slice(0, 200)}`)
    }
    return envelope.data
  }

  /** 第一步：取授权 URL（state 由服务端签发）。 */
  async begin(realm: Realm): Promise<AuthState> {
    const { base } = realmEndpoints(realm)
    const data = await this.call<{ state?: string; authUrl?: string }>(
      `${base}/v2/plugin/auth/state?platform=CLI`,
      realm,
      { method: 'POST', body: '{}' },
    )
    if (typeof data.state !== 'string' || data.state === '' || typeof data.authUrl !== 'string' || data.authUrl === '') {
      throw new Error('上游未返回 state 或 authUrl，登录无法继续。')
    }
    return { state: data.state, authUrl: data.authUrl }
  }

  /** 第二步：轮询 token（用户在浏览器完成授权后才有值）。 */
  async poll(realm: Realm, state: string): Promise<TokenBundle> {
    const { base } = realmEndpoints(realm)
    const data = await this.call<{
      accessToken?: string
      refreshToken?: string
      expiresIn?: number
      domain?: string
    }>(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, realm, { method: 'GET' })
    if (typeof data.accessToken !== 'string' || data.accessToken === '') {
      throw new LoginPendingError('登录尚未完成：token 端点还没有返回 accessToken。')
    }
    return {
      accessToken: data.accessToken,
      refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : '',
      expiresIn: typeof data.expiresIn === 'number' ? data.expiresIn : 0,
      domain: typeof data.domain === 'string' ? data.domain : '',
    }
  }

  /** 第三步：取账号信息（uid / nickname / enterpriseId）。 */
  async account(realm: Realm, state: string, token: string): Promise<AccountInfo> {
    const { base } = realmEndpoints(realm)
    const data = await this.call<{ uid?: string; enterpriseId?: string; nickname?: string }>(
      `${base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
      realm,
      { method: 'GET', token },
    )
    return {
      uid: typeof data.uid === 'string' ? data.uid : '',
      enterpriseId: typeof data.enterpriseId === 'string' ? data.enterpriseId : '',
      nickname: typeof data.nickname === 'string' ? data.nickname : '',
    }
  }

  /**
   * 完整登录：begin → （外部完成浏览器授权）→ poll → account。
   *
   * 调用方负责在 begin 与 poll 之间把 URL 给用户、等他确认。
   */
  async complete(realm: Realm, state: string): Promise<LoginResult> {
    const token = await this.poll(realm, state)
    const account = await this.account(realm, state, token.accessToken)
    return { realm, token, account }
  }

  /**
   * CN 签到（best-effort）。
   *
   * 完全对齐 `login.sh` 的行为：**失败只提示，绝不影响登录结果**（凭证此时已经拿到，
   * 因为签到失败就让整次登录失败是本末倒置）。global 不签到（上游标注该端点未实测）。
   */
  async checkin(realm: Realm, token: TokenBundle, account: AccountInfo): Promise<string | undefined> {
    const endpoints = realmEndpoints(realm)
    if (endpoints.checkinBase === undefined) return undefined
    try {
      const response = await this.fetchImpl(`${endpoints.checkinBase}/v2/billing/meter/daily-checkin`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-User-Id': account.uid,
          ...account.enterpriseId !== '' ? { 'X-Enterprise-Id': account.enterpriseId, 'X-Tenant-Id': account.enterpriseId } : {},
          ...token.domain !== '' ? { 'X-Domain': token.domain } : {},
        },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      })
      const body = await response.json().catch(() => undefined) as { code?: number; msg?: string; data?: unknown } | undefined
      if (body === undefined) return `HTTP ${response.status}`
      if (body.code === 0) return `成功 ${JSON.stringify(body.data ?? {}).slice(0, 150)}`
      return body.msg ?? `HTTP ${response.status}`
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}

/** 落盘用的 auth 文件结构（与网关 `internal/auth` 的嵌套形一致）。 */
export interface AuthFileDocument {
  account: { uid: string; enterpriseId: string; nickname: string }
  auth: { accessToken: string; refreshToken: string; expiresAt: number; domain: string; realm: Realm }
}

/**
 * 组装 auth 文件内容。
 *
 * `expiresAt` 由 `expiresIn`（秒）**加上当前时间**得出 —— 上游 `login.sh` 用
 * `date +%s` 做同一件事。这里把 `now` 作为参数注入，便于测试断言确切数值。
 *
 * @param result - 登录结果。
 * @param nowSeconds - 当前 Unix 秒；缺省取系统时间。
 */
export function buildAuthFile(result: LoginResult, nowSeconds = Math.floor(Date.now() / 1000)): AuthFileDocument {
  return {
    account: {
      uid: result.account.uid,
      enterpriseId: result.account.enterpriseId,
      nickname: result.account.nickname,
    },
    auth: {
      accessToken: result.token.accessToken,
      refreshToken: result.token.refreshToken,
      expiresAt: nowSeconds + result.token.expiresIn,
      domain: result.token.domain,
      // 上游 buildLoginOutput 保证 realm 恒非空（显式优先，其次按 domain 推断）。
      realm: inferRealm(result.realm, result.token.domain),
    },
  }
}

/**
 * 落盘 auth 文件（原子写）。
 *
 * 文件名沿用上游约定 `workbuddy-<uid>.json` —— 它同时满足两件事：匹配网关的
 * `workbuddy*.json` glob，且同一 uid 重复登录只会**覆盖**同一份凭证
 * （插件 `/wb2api-account` 的启用/禁用状态因此不会被新登录打乱）。
 *
 * @returns 写入的文件绝对路径。
 * @throws uid 为空（拿不到账号身份时写出去的文件网关也读不了）时。
 */
export function writeAuthFile(authDir: string, document: AuthFileDocument): string {
  if (document.account.uid === '') {
    throw new Error('登录响应里没有 uid，无法确定凭证文件名（网关要求 workbuddy-<uid>.json）。')
  }
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true })
  const file = join(authDir, `workbuddy-${document.account.uid}.json`)
  const temp = `${file}.part`
  // indent: 1 与上游 login.sh 的 json.dump(..., indent=1) 一致，便于人工比对 diff。
  writeFileSync(temp, `${JSON.stringify(document, null, 1)}\n`, { mode: 0o600 })
  renameSync(temp, file)
  return file
}
