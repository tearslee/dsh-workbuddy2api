/**
 * 账号开关的契约测试。
 *
 * 这套逻辑的危险点不在「能不能改名」，而在**改错之后很难发现**：
 *
 *   - 切换的物理效果落在 auths/ 目录的文件名上（网关只认 `workbuddy*.json`），
 *     所以「少禁一个号」= 网关仍在轮换那个本该被排除的账号，而 UI 上没有任何异常；
 *   - 反过来「多禁一个号」= 池里账号变少，请求照样成功，只是负载全压在一个号上。
 *
 * 因此这里断言的重点是**目录的最终形态**（谁启用、谁禁用），而不是某次调用的返回值：
 * 每个用例结束都重新 `list()` 复核，等价于网关重启后会读到什么。
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { AccountStore, DISABLED_SUFFIX, parseAccountSelector, planRenames } from '../../src/accounts.js'

/** 静默 logger：这些用例只关心文件形态，不关心日志。 */
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** 造一个最小可解析的凭证文件（token 用占位符，本模块从不读取其内容）。 */
function authFileJson(uid: string, nickname: string, realm: 'cn' | 'global'): string {
  return JSON.stringify({
    auth: {
      accessToken: 'placeholder',
      domain: realm === 'global' ? 'www.workbuddy.ai' : 'copilot.tencent.com',
      expiresAt: 1,
      realm,
      refreshToken: 'placeholder',
    },
    account: { uid, nickname, enterpriseId: '' },
  })
}

const SEED = [
  { uid: 'oneid_1000000000000000001', nickname: 'alpha', realm: 'cn' as const },
  { uid: 'oneid_2000000000000000002', nickname: 'beta', realm: 'cn' as const },
  { uid: 'oneid_3000000000000000003', nickname: 'gamma', realm: 'global' as const },
]

const created: string[] = []

/** 建一个临时网关根目录（含 config.json + auths/），返回 store 与目录路径。 */
function setup(seeds = SEED): { store: AccountStore; dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'wb2a-accounts-'))
  created.push(root)
  const dir = join(root, 'auths')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ auth_dir: './auths' }))
  for (const seed of seeds) {
    writeFileSync(join(dir, `workbuddy-${seed.uid}.json`), authFileJson(seed.uid, seed.nickname, seed.realm))
  }
  const store = new AccountStore({ config: { ...DEFAULT_CONFIG, repoPath: root }, logger: silentLogger })
  return { store, dir, root }
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响断言结果，忽略（本机 safe-delete 钩子可能改写删除行为）。
    }
  }
})

describe('AccountStore.list', () => {
  it('识别凭证文件并读出 uid / 昵称 / 域', () => {
    const { store } = setup()
    const accounts = store.list()
    expect(accounts).toHaveLength(3)
    expect(accounts.every(a => a.enabled)).toBe(true)
    expect(accounts.map(a => a.nickname).sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(accounts.find(a => a.nickname === 'gamma')?.realm).toBe('global')
    expect(accounts.find(a => a.nickname === 'alpha')?.realm).toBe('cn')
  })

  it('把 .json.disabled 视为禁用，不计入网关可见集', () => {
    const { store, dir } = setup()
    const off = SEED[1]!
    renameSync(
      join(dir, `workbuddy-${off.uid}.json`),
      join(dir, `workbuddy-${off.uid}.json${DISABLED_SUFFIX}`),
    )
    const accounts = store.list()
    expect(accounts).toHaveLength(3)
    expect(store.enabledCount()).toBe(2)
    const hit = accounts.find(a => a.uid === off.uid)
    // 禁用的账号仍要能读出身份 —— 否则弹窗里就只能显示一串文件名，无法判断该恢复谁。
    expect(hit?.nickname).toBe('beta')
    expect(hit?.enabled).toBe(false)
    // 启用的排前面：命令输出的「序号」必须与弹窗列表顺序一致。
    expect(accounts.slice(0, 2).every(a => a.enabled)).toBe(true)
  })

  it('忽略非凭证文件（后缀不对、前缀不对、缺 uid）', () => {
    const { store, dir } = setup()
    writeFileSync(join(dir, 'workbuddy-broken.json'), '{"account":{}}')
    writeFileSync(join(dir, 'workbuddy-notjson.json'), 'not json at all')
    writeFileSync(join(dir, 'other.json'), authFileJson('x', 'x', 'cn'))
    writeFileSync(join(dir, 'workbuddy-note.txt'), 'hello')
    expect(store.list()).toHaveLength(3)
  })

  it('authDir 跟随网关 config.json 的 auth_dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb2a-accounts-'))
    created.push(root)
    const custom = join(root, 'creds')
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(root, 'config.json'), JSON.stringify({ auth_dir: './creds' }))
    const store = new AccountStore({ config: { ...DEFAULT_CONFIG, repoPath: root }, logger: silentLogger })
    expect(store.authDir()).toBe(custom)
  })
})

describe('planRenames / applySelection', () => {
  it('指定单个账号 → 其余全部改名禁用，且文件仍可恢复', () => {
    const { store, dir } = setup()
    const target = SEED[2]!
    const plan = planRenames(store.list(), { kind: 'single', uid: target.uid })
    expect(plan).toHaveLength(2)
    expect(plan.every(item => item.enabled === false)).toBe(true)

    const result = store.applySelection({ kind: 'single', uid: target.uid })
    expect(result.renamed).toHaveLength(2)
    const after = store.list()
    expect(after.filter(a => a.enabled).map(a => a.uid)).toEqual([target.uid])
    expect(store.enabledCount()).toBe(1)
    // 被禁用的文件仍在原目录里（只改名、从不删除），恢复不需要任何映射表。
    expect(after.filter(a => !a.enabled)).toHaveLength(2)
    expect(dir).toBe(store.authDir())
  })

  it('auto 恢复全部账号，且过程可反复来回', () => {
    const { store } = setup()
    const target = SEED[0]!
    store.applySelection({ kind: 'single', uid: target.uid })
    expect(store.enabledCount()).toBe(1)

    const restored = store.applySelection({ kind: 'auto' })
    expect(restored.renamed).toHaveLength(2)
    expect(store.enabledCount()).toBe(3)

    // 再切一次单号：这次要禁用的是另外两个，顺序无关但集合必须正确。
    const again = store.applySelection({ kind: 'single', uid: target.uid })
    expect(again.renamed).toHaveLength(2)
    expect(store.list().filter(a => a.enabled).map(a => a.uid)).toEqual([target.uid])
  })

  it('已处于目标状态时计划为空（调用方据此跳过重启网关）', () => {
    const { store } = setup()
    expect(planRenames(store.list(), { kind: 'auto' })).toHaveLength(0)
    const target = SEED[1]!
    store.applySelection({ kind: 'single', uid: target.uid })
    // 再切同一个号：没有任何文件需要动 —— 这是幂等性的关键断言，
    // 否则每次切换都会白停一次网关。
    expect(planRenames(store.list(), { kind: 'single', uid: target.uid })).toHaveLength(0)
    expect(store.applySelection({ kind: 'single', uid: target.uid }).renamed).toHaveLength(0)
  })

  it('uid 不存在时抛错且不改动任何文件', () => {
    const { store } = setup()
    expect(() => store.applySelection({ kind: 'single', uid: 'oneid_missing' })).toThrow(/未找到 uid/)
    expect(store.enabledCount()).toBe(3)
  })

  it('同一 uid 存在两份凭证文件时拒绝执行（无法表达「只启用它」）', () => {
    const { store, dir } = setup()
    const uid = SEED[0]!.uid
    writeFileSync(join(dir, `workbuddy-${uid}.json${DISABLED_SUFFIX}`), authFileJson(uid, 'alpha', 'cn'))
    expect(() => planRenames(store.list(), { kind: 'single', uid })).toThrow(/同时存在/)
  })
})

describe('parseAccountSelector', () => {
  it('识别 auto（大小写不敏感）', () => {
    const { store } = setup()
    expect(parseAccountSelector(store.list(), 'auto')).toEqual({ kind: 'auto' })
    expect(parseAccountSelector(store.list(), '  AUTO ')).toEqual({ kind: 'auto' })
  })

  it('序号按列表顺序解析（1 起）', () => {
    const { store } = setup()
    const accounts = store.list()
    expect(parseAccountSelector(accounts, '1')).toEqual({ kind: 'single', uid: accounts[0]!.uid })
    expect(parseAccountSelector(accounts, '3')).toEqual({ kind: 'single', uid: accounts[2]!.uid })
  })

  it('序号越界 / uid 前缀无命中 / 前缀模糊 都报错并给出可用线索', () => {
    const { store } = setup()
    const accounts = store.list()
    expect(() => parseAccountSelector(accounts, '9')).toThrow(/超出范围/)
    expect(() => parseAccountSelector(accounts, 'oneid_zzz')).toThrow(/没有 uid 以/)
    // 两个 uid 都以 oneid_ 开头 → 必须要求写得更具体，而不是随便挑一个。
    expect(() => parseAccountSelector(accounts, 'oneid_')).toThrow(/命中 3 个账号/)
  })

  it('uid 前缀唯一命中时可用', () => {
    const { store } = setup()
    expect(parseAccountSelector(store.list(), 'oneid_30000')).toEqual({ kind: 'single', uid: SEED[2]!.uid })
  })

  it('空参数报错（不带参数走弹窗路径，不走这里）', () => {
    const { store } = setup()
    expect(() => parseAccountSelector(store.list(), '   ')).toThrow(/缺少参数/)
  })
})
