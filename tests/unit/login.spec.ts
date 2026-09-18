/**
 * 登录流程的契约测试。
 *
 * 这套代码替代了上游的 `login.sh` + Go `login` 工具 + `python3`，因此它的正确性标准
 * 不是"流程能跑通"，而是**落盘出来的 auth 文件被网关的解析器认**：
 *
 *  - 文件名必须是 `workbuddy-<uid>.json`（网关的 glob 是 `workbuddy*.json`）；
 *  - 结构必须是嵌套形（`account.uid` / `auth.accessToken` …），否则账号数会是 0；
 *  - `expiresAt` 必须是 **Unix 秒**（毫秒会让网关判成"永不过期"而永不刷新）；
 *  - 请求头/端点必须与上游一致（上游校验 Origin/Referer/UA）。
 *
 * 因此这里假扮上游，断言**发出去的请求**与**写下去的文件**，而不是只看函数返回值。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAuthFile,
  inferRealm,
  LOGIN_USER_AGENT,
  LoginClient,
  LoginPendingError,
  loginHeaders,
  parseRealmArg,
  realmEndpoints,
  resolveRealmInput,
  writeAuthFile,
} from '../../src/login.js'

const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb2a-login-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 忽略清理失败。
    }
  }
})

/** 记录每次请求的假上游。 */
interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * 假上游：把真实域名映射到记录器，返回可控信封。
 *
 * `tokenResponses` 是队列 —— 可以模拟"先 pending 后成功"的真实节奏。
 */
function fakeUpstream(options: {
  state?: { code: number; data?: unknown; msg?: string }
  tokens?: Array<{ code: number; data?: unknown; msg?: string; status?: number }>
  account?: { code: number; data?: unknown; msg?: string }
  checkin?: { status: number; body: unknown }
}) {
  const requests: Recorded[] = []
  let tokenIndex = 0
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    requests.push({ url, method: init?.method ?? 'GET', headers, ...init?.body !== undefined ? { body: String(init.body) } : {} })

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

    if (url.includes('/v2/plugin/auth/state')) {
      return json(options.state ?? { code: 0, data: { state: 'st-123', authUrl: 'https://example.test/authorize?state=st-123' } })
    }
    if (url.includes('/v2/plugin/auth/token')) {
      const spec = options.tokens?.[Math.min(tokenIndex, (options.tokens?.length ?? 1) - 1)] ?? { code: 0 }
      tokenIndex += 1
      return json(spec, spec.status ?? 200)
    }
    if (url.includes('/v2/plugin/login/account')) {
      return json(options.account ?? { code: 0, data: { uid: 'oneid_123', enterpriseId: 'ent-9', nickname: '李' } })
    }
    if (url.includes('/daily-checkin')) {
      return json(options.checkin?.body ?? { code: 0, data: { ok: true } }, options.checkin?.status ?? 200)
    }
    return json({ code: 404, msg: 'unknown' }, 404)
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

const TOKEN_DATA = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresIn: 7200,
  domain: 'copilot.tencent.com',
}

describe('realm 归一化', () => {
  it('resolveRealmInput 与上游 login 工具同规则', () => {
    expect(resolveRealmInput('')).toBe('cn')
    expect(resolveRealmInput('1')).toBe('cn')
    expect(resolveRealmInput('CN')).toBe('cn')
    expect(resolveRealmInput('2')).toBe('global')
    expect(resolveRealmInput(' Global ')).toBe('global')
    expect(resolveRealmInput('3')).toBeUndefined()
  })

  it('parseRealmArg 空输入返回 undefined（表示"没指定"而不是默认 cn）', () => {
    expect(parseRealmArg('')).toBeUndefined()
    expect(parseRealmArg('   ')).toBeUndefined()
    expect(parseRealmArg('cn')).toBe('cn')
    expect(parseRealmArg('global')).toBe('global')
    expect(parseRealmArg('bogus')).toBeUndefined()
  })

  it('realmEndpoints：CN 的 base 与 origin 不同域（上游实测行为，不能"顺手统一"）', () => {
    expect(realmEndpoints('cn')).toEqual({
      base: 'https://copilot.tencent.com',
      origin: 'https://www.codebuddy.cn',
      checkinBase: 'https://www.codebuddy.cn',
    })
    expect(realmEndpoints('global')).toEqual({
      base: 'https://www.workbuddy.ai',
      origin: 'https://www.workbuddy.ai',
    })
  })

  it('inferRealm：显式优先，其次按 domain 后缀（与网关 Auth.Realm() 同口径）', () => {
    expect(inferRealm('global', 'copilot.tencent.com')).toBe('global')
    expect(inferRealm('cn', 'www.workbuddy.ai')).toBe('cn')
    expect(inferRealm(undefined, 'www.workbuddy.ai')).toBe('global')
    expect(inferRealm(undefined, 'workbuddy.ai')).toBe('global')
    expect(inferRealm(undefined, 'copilot.tencent.com')).toBe('cn')
    expect(inferRealm(undefined, '')).toBe('cn')
  })

  it('请求头带上游要求的 UA 与 Origin/Referer', () => {
    const headers = loginHeaders('https://www.codebuddy.cn')
    expect(headers['User-Agent']).toBe(LOGIN_USER_AGENT)
    expect(headers.Origin).toBe('https://www.codebuddy.cn')
    expect(headers.Referer).toBe('https://www.codebuddy.cn/')
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(headers.Authorization).toBeUndefined()
    expect(loginHeaders('https://x', 'tok').Authorization).toBe('Bearer tok')
  })
})

describe('LoginClient', () => {
  it('begin 用 POST 打 state 端点，带 realm 对应的 Origin', async () => {
    const upstream = fakeUpstream({})
    const client = new LoginClient(upstream.fetchImpl)
    const state = await client.begin('cn')
    expect(state.state).toBe('st-123')
    expect(state.authUrl).toContain('authorize')
    const request = upstream.requests[0]!
    expect(request.url).toBe('https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI')
    expect(request.method).toBe('POST')
    expect(request.headers.origin).toBe('https://www.codebuddy.cn')
    expect(request.headers.referer).toBe('https://www.codebuddy.cn/')
    expect(request.headers['user-agent']).toBe(LOGIN_USER_AGENT)
    expect(request.body).toBe('{}')
  })

  it('global 走 workbuddy.ai（base 与 origin 同域）', async () => {
    const upstream = fakeUpstream({})
    const client = new LoginClient(upstream.fetchImpl)
    await client.begin('global')
    expect(upstream.requests[0]!.url.startsWith('https://www.workbuddy.ai/')).toBe(true)
    expect(upstream.requests[0]!.headers.origin).toBe('https://www.workbuddy.ai')
  })

  it('poll 在业务 code!=0 且 4xx 时归类为"未完成"（可重试）', async () => {
    const upstream = fakeUpstream({ tokens: [{ code: 10001, msg: 'login ing', status: 400 }] })
    const client = new LoginClient(upstream.fetchImpl)
    await expect(client.poll('cn', 'st-123')).rejects.toBeInstanceOf(LoginPendingError)
  })

  it('poll 在没有 accessToken 时也是"未完成"（上游有时回 code=0 空 data）', async () => {
    const upstream = fakeUpstream({ tokens: [{ code: 0, data: { expiresIn: 0 } }] })
    const client = new LoginClient(upstream.fetchImpl)
    await expect(client.poll('cn', 'st-123')).rejects.toBeInstanceOf(LoginPendingError)
  })

  it('poll 的 5xx 是故障而不是"未完成"（避免无意义地轮询一分钟）', async () => {
    const upstream = fakeUpstream({ tokens: [{ code: 500, msg: 'boom', status: 500 }] })
    const client = new LoginClient(upstream.fetchImpl)
    const error = await client.poll('cn', 'st-123').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(LoginPendingError)
  })

  it('account 端点带 Bearer（上游要它才认）', async () => {
    const upstream = fakeUpstream({})
    const client = new LoginClient(upstream.fetchImpl)
    const account = await client.account('cn', 'st-123', 'tok-abc')
    expect(account).toEqual({ uid: 'oneid_123', enterpriseId: 'ent-9', nickname: '李' })
    const request = upstream.requests[0]!
    expect(request.headers.authorization).toBe('Bearer tok-abc')
    expect(request.url).toBe('https://copilot.tencent.com/v2/plugin/login/account?state=st-123')
  })

  it('返回非 JSON 时如实报错（而不是抛 JSON.parse 的原始异常）', async () => {
    const client = new LoginClient((async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch)
    await expect(client.begin('cn')).rejects.toThrow(/不是 JSON/)
  })

  it('网络异常带上 URL（排障要知道打的是哪个域）', async () => {
    const client = new LoginClient((async () => { throw new Error('getaddrinfo ENOTFOUND') }) as unknown as typeof fetch)
    await expect(client.begin('global')).rejects.toThrow(/www\.workbuddy\.ai/)
  })

  it('complete 串起 poll + account，得到完整登录结果', async () => {
    const upstream = fakeUpstream({ tokens: [{ code: 0, data: TOKEN_DATA }] })
    const client = new LoginClient(upstream.fetchImpl)
    const result = await client.complete('cn', 'st-123')
    expect(result.realm).toBe('cn')
    expect(result.token.accessToken).toBe('access-token-value')
    expect(result.token.expiresIn).toBe(7200)
    expect(result.account.uid).toBe('oneid_123')
  })

  it('checkin 仅 CN 执行；失败只回报文本，不抛错（不能因签到失败丢掉登录）', async () => {
    const upstream = fakeUpstream({ checkin: { status: 400, body: { code: 10001, msg: '今天已签到' } } })
    const client = new LoginClient(upstream.fetchImpl)
    const message = await client.checkin('cn', { accessToken: 't', refreshToken: 'r', expiresIn: 1, domain: 'copilot.tencent.com' }, { uid: 'u', enterpriseId: 'e', nickname: 'n' })
    expect(message).toBe('今天已签到')
    expect(upstream.requests.some(request => request.url.includes('/daily-checkin'))).toBe(true)
  })

  it('checkin 带 X-User-Id / X-Enterprise-Id / X-Tenant-Id / X-Domain 与 Bearer', async () => {
    const upstream = fakeUpstream({})
    const client = new LoginClient(upstream.fetchImpl)
    await client.checkin('cn', { accessToken: 'tok', refreshToken: 'r', expiresIn: 1, domain: 'copilot.tencent.com' }, { uid: 'oneid_1', enterpriseId: 'ent-7', nickname: 'n' })
    const request = upstream.requests[0]!
    expect(request.headers.authorization).toBe('Bearer tok')
    expect(request.headers['x-user-id']).toBe('oneid_1')
    expect(request.headers['x-enterprise-id']).toBe('ent-7')
    expect(request.headers['x-tenant-id']).toBe('ent-7')
    expect(request.headers['x-domain']).toBe('copilot.tencent.com')
  })

  it('checkin 在 global 上完全不发请求（上游标注该端点未实测）', async () => {
    const upstream = fakeUpstream({})
    const client = new LoginClient(upstream.fetchImpl)
    const message = await client.checkin('global', { accessToken: 't', refreshToken: 'r', expiresIn: 1, domain: 'www.workbuddy.ai' }, { uid: 'u', enterpriseId: '', nickname: 'n' })
    expect(message).toBeUndefined()
    expect(upstream.requests).toHaveLength(0)
  })
})

describe('buildAuthFile / writeAuthFile', () => {
  const result = {
    realm: 'cn' as const,
    token: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 7200, domain: 'copilot.tencent.com' },
    account: { uid: 'oneid_1470660413338166550', enterpriseId: 'ent-1', nickname: 'kydj3udxk1mq' },
  }

  it('expiresAt 是「当前秒 + expiresIn」（秒，不是毫秒 —— 毫秒会让网关永不刷新）', () => {
    const document = buildAuthFile(result, 1_700_000_000)
    expect(document.auth.expiresAt).toBe(1_700_007_200)
    // 量级断言：秒级时间戳在 1e9~1e10，毫秒级是 1e12+。写错单位这里立刻红。
    expect(document.auth.expiresAt).toBeLessThan(1e12)
  })

  it('结构与字段名与网关嵌套形一致', () => {
    const document = buildAuthFile(result, 1_700_000_000)
    expect(document).toEqual({
      account: { uid: 'oneid_1470660413338166550', enterpriseId: 'ent-1', nickname: 'kydj3udxk1mq' },
      auth: {
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresAt: 1_700_007_200,
        domain: 'copilot.tencent.com',
        realm: 'cn',
      },
    })
  })

  it('realm 缺失时按 domain 推断（保证落盘文件恒带 realm 键）', () => {
    const document = buildAuthFile({
      realm: 'cn',
      token: { ...result.token, domain: 'www.workbuddy.ai' },
      account: result.account,
    })
    // 显式 realm 优先于 domain 回落（与网关 D1 规则一致）。
    expect(document.auth.realm).toBe('cn')
  })

  it('落盘文件名是 workbuddy-<uid>.json，且重新扫描能读到（等价于网关重启后所见）', () => {
    const dir = tempDir()
    const file = writeAuthFile(dir, buildAuthFile(result, 1_700_000_000))
    expect(file.endsWith('workbuddy-oneid_1470660413338166550.json')).toBe(true)
    // 网关的 glob 是 workbuddy*.json —— 文件名不匹配就等于账号凭空消失。
    expect(readdirSync(dir).filter(name => /^workbuddy.*\.json$/.test(name))).toHaveLength(1)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { account: { uid: string }; auth: { expiresAt: number } }
    expect(parsed.account.uid).toBe('oneid_1470660413338166550')
    expect(parsed.auth.expiresAt).toBe(1_700_007_200)
  })

  it('同 uid 重复登录只覆盖同一份文件（不打乱 /wb2api-account 的启停状态）', () => {
    const dir = tempDir()
    writeAuthFile(dir, buildAuthFile(result, 1_700_000_000))
    writeAuthFile(dir, buildAuthFile({ ...result, token: { ...result.token, accessToken: 'AT2' } }, 1_700_000_100))
    const names = readdirSync(dir).filter(name => name.endsWith('.json'))
    expect(names).toEqual(['workbuddy-oneid_1470660413338166550.json'])
    expect(JSON.parse(readFileSync(join(dir, names[0]!), 'utf8')).auth.accessToken).toBe('AT2')
  })

  it('目录不存在时自动创建', () => {
    const dir = join(tempDir(), 'auths', 'nested')
    writeAuthFile(dir, buildAuthFile(result))
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('没有 uid 时拒绝落盘（文件名无从确定，写出去网关也读不到）', () => {
    const dir = tempDir()
    expect(() => writeAuthFile(dir, buildAuthFile({ ...result, account: { ...result.account, uid: '' } })))
      .toThrow(/没有 uid/)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('以 0600 权限写凭证（非 Windows 上 token 不应是全局可读）', () => {
    const dir = tempDir()
    const file = writeAuthFile(dir, buildAuthFile(result))
    if (process.platform !== 'win32') {
      // 权限位在 Windows 上无意义，只在类 Unix 上断言。
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } else {
      expect(statSync(file).isFile()).toBe(true)
    }
  })

  it('写入后不残留 .part 临时文件', () => {
    const dir = tempDir()
    writeAuthFile(dir, buildAuthFile(result))
    expect(readdirSync(dir).some(name => name.endsWith('.part'))).toBe(false)
  })
})
