/**
 * 一键就绪编排的契约测试。
 *
 * 编排代码的失败模式是**汇报失真**：明明没就绪却说"全部就绪"、明明卡在登录却说
 * "网关启动失败"。用户在 dsh 里只看到一段文字，所以这里的断言重点是：
 *
 *  1. `ready` 与实际状态一致（healthy=0 时绝不能是 ready）；
 *  2. 失败时**停在正确的步骤**并带上可操作的原因；
 *  3. 已满足的条件不重复做（幂等：第二次跑不重新下载、不重新登录）；
 *  4. 新登录后走 restart 而不是 start（网关只在启动时扫 auths/）。
 *
 * 与 account-switch.spec.ts 同样的原则：断言**目录的最终形态**（真实写文件后重新扫描），
 * 而不是断言某个函数的返回值。
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore, type AuthAccount } from '../../src/accounts.js'
import { DEFAULT_CONFIG } from '../../src/config.js'
import type { GatewayStatus } from '../../src/gateway-supervisor.js'
import type { GatewayBinaryInstaller, InstallResult } from '../../src/gateway-binary.js'
import type { Realm } from '../../src/login.js'
import { renderSetupReport, SetupRunner, type LoginOutcome } from '../../src/setup.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const created: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb2a-setup-'))
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

/** 造一个已启用账号的 auths 目录，并返回可用的 store。 */
function storeWithAccount(root: string, uid = 'oneid_1', nickname = 'alpha'): AccountStore {
  const auths = join(root, 'auths')
  mkdirSync(auths, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ auth_dir: './auths' }))
  writeFileSync(join(auths, `workbuddy-${uid}.json`), JSON.stringify({
    account: { uid, nickname, enterpriseId: '' },
    auth: { accessToken: 'x', refreshToken: 'y', expiresAt: 1, domain: 'copilot.tencent.com', realm: 'cn' },
  }))
  return new AccountStore({ config: { ...DEFAULT_CONFIG, repoPath: root }, logger: silentLogger })
}

/** 空账号目录的 store。 */
function emptyStore(root: string): AccountStore {
  mkdirSync(join(root, 'auths'), { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ auth_dir: './auths' }))
  return new AccountStore({ config: { ...DEFAULT_CONFIG, repoPath: root }, logger: silentLogger })
}

/** 假的二进制安装器：把文件真的写下去（默认路径必须存在，否则编排会判定失败）。 */
function fakeInstaller(options: { downloaded?: boolean; fail?: string; write?: boolean; runtimeCreated?: boolean } = {}) {
  const calls: number[] = []
  const runtimeCalls: number[] = []
  const dir = tempRoot()
  const path = join(dir, 'wb2a-server.exe')
  const runtimeDir = join(dir, 'runtime')
  const installer = {
    prepareRuntime: () => {
      runtimeCalls.push(1)
      const created = options.runtimeCreated ?? false
      return {
        dir: runtimeDir,
        configPath: join(runtimeDir, 'config.json'),
        created,
        dirsCreated: created ? [join(runtimeDir, 'auths'), join(runtimeDir, 'data')] : [],
      }
    },
    ensure: async (): Promise<InstallResult> => {
      calls.push(1)
      if (options.fail !== undefined) throw new Error(options.fail)
      if (options.write !== false) writeFileSync(path, 'binary')
      return {
        path,
        downloaded: options.downloaded ?? true,
        asset: 'wb2a-server-windows-amd64.zip',
        sha256: 'a'.repeat(64),
        bytes: 6,
        runtimeDir,
        configPath: join(runtimeDir, 'config.json'),
        configCreated: options.runtimeCreated ?? true,
        dirsCreated: options.runtimeCreated === false ? [] : [join(runtimeDir, 'auths')],
      }
    },
  } as unknown as Pick<GatewayBinaryInstaller, 'ensure' | 'prepareRuntime'>
  return { installer, path, calls, runtimeCalls }
}

/** 假 supervisor。 */
function fakeSupervisor(options: {
  resolveFails?: string
  status?: Partial<GatewayStatus>
  restart?: boolean
} = {}) {
  const calls: string[] = []
  const status: GatewayStatus = {
    state: 'running',
    baseURL: 'http://127.0.0.1:7863/v1',
    port: 7863,
    binaryPath: 'C:/fake/wb2a-server.exe',
    restarts: 0,
    health: { healthy: 1, total: 1, raw: {} },
    ...options.status,
  }
  return {
    calls,
    supervisor: {
      resolveBinary: async (): Promise<string> => {
        calls.push('resolveBinary')
        if (options.resolveFails !== undefined) throw new Error(options.resolveFails)
        return 'C:/fake/wb2a-server.exe'
      },
      start: async (): Promise<GatewayStatus> => {
        calls.push('start')
        return status
      },
      restart: async (): Promise<GatewayStatus> => {
        calls.push('restart')
        return status
      },
    },
  }
}

/** 组装 runner；默认全部依赖就绪。 */
function makeRunner(overrides: {
  root?: string
  store?: AccountStore
  supervisor?: ReturnType<typeof fakeSupervisor>['supervisor']
  installer?: Pick<GatewayBinaryInstaller, 'ensure' | 'prepareRuntime'>
  login?: (realm: Realm | undefined) => Promise<LoginOutcome>
  refreshModels?: () => Promise<unknown>
  binaryPath?: string
  repoPath?: string
} = {}) {
  const root = overrides.root ?? tempRoot()
  const refreshCalls: number[] = []
  const runner = new SetupRunner({
    // repoPath 默认留空 = 运行目录由插件托管（与真实默认配置一致）。
    config: {
      ...DEFAULT_CONFIG,
      repoPath: overrides.repoPath ?? '',
      binaryPath: overrides.binaryPath ?? '',
    },
    ...overrides.supervisor !== undefined ? { supervisor: overrides.supervisor } : {},
    accountStore: overrides.store ?? storeWithAccount(root),
    installer: overrides.installer ?? fakeInstaller().installer,
    performLogin: overrides.login ?? (async () => ({ ok: true, uid: 'oneid_1' })),
    refreshModels: overrides.refreshModels ?? (async () => { refreshCalls.push(1); return [{ id: 'a' }, { id: 'b' }] }),
    logger: silentLogger,
  })
  return { runner, refreshCalls, root }
}

describe('SetupRunner：全部条件已满足', () => {
  it('有二进制 + 有账号 → 不下载、不登录，启动网关并刷新模型', async () => {
    const supervisor = fakeSupervisor()
    let loginCalled = false
    const { runner, refreshCalls } = makeRunner({
      supervisor: supervisor.supervisor,
      login: async () => { loginCalled = true; return { ok: true } },
    })

    const outcome = await runner.run(undefined)
    expect(outcome.ready).toBe(true)
    expect(loginCalled).toBe(false)
    // 已有账号时不应该 restart（restart 会白白中断一次在途请求）。
    expect(supervisor.calls).toEqual(['resolveBinary', 'start'])
    expect(refreshCalls).toHaveLength(1)
    // 运行目录未新建时不插入多余步骤（步骤数保持 4）。
    expect(outcome.steps.map(step => step.status)).toEqual(['ok', 'skipped', 'ok', 'ok'])
  })

  it('二进制已在位但运行目录缺失 → 补建 config.json（否则网关直接退出）', async () => {
    // 这是实测发现的真实故障：更早版本的插件只下载二进制、不生成 config.json，
    // 而网关在缺配置时 `log.Fatalf` 直接退出（上游 os.IsNotExist 判不透包装错误）。
    const supervisor = fakeSupervisor()
    const { installer, runtimeCalls } = fakeInstaller({ runtimeCreated: true })
    const { runner } = makeRunner({ supervisor: supervisor.supervisor, installer })

    const outcome = await runner.run(undefined)
    expect(runtimeCalls).toHaveLength(1)
    const step = outcome.steps.find(item => item.title === '准备网关运行目录')!
    expect(step.status).toBe('ok')
    expect(step.detail).toMatch(/api_key/)
    // 运行目录补建后仍应正常启动。
    expect(outcome.ready).toBe(true)
  })

  it('用户自己配了 repoPath → 不去动插件的运行目录（尊重用户自己的目录）', async () => {
    const root = tempRoot()
    const supervisor = fakeSupervisor()
    const { installer, runtimeCalls } = fakeInstaller({ runtimeCreated: true })
    const { runner } = makeRunner({
      root,
      repoPath: root,
      store: storeWithAccount(root),
      supervisor: supervisor.supervisor,
      installer,
    })

    await runner.run(undefined)
    expect(runtimeCalls).toHaveLength(0)
  })
})

describe('SetupRunner：二进制缺失', () => {
  it('未配置 binaryPath 且找不到 → 下载安装后继续', async () => {
    const supervisor = fakeSupervisor({ resolveFails: '未找到网关可执行文件' })
    const { installer, calls } = fakeInstaller()
    const { runner } = makeRunner({ supervisor: supervisor.supervisor, installer })

    const outcome = await runner.run(undefined)
    expect(calls).toHaveLength(1)
    expect(outcome.ready).toBe(true)
    expect(outcome.binaryPath).toBeDefined()
    expect(outcome.steps[0]!.title).toBe('下载网关可执行文件')
    expect(outcome.steps[0]!.detail).toMatch(/sha256 a{12}/)
  })

  it('下载失败 → 停在第一步，不启动网关', async () => {
    const supervisor = fakeSupervisor({ resolveFails: '未找到' })
    const { installer } = fakeInstaller({ fail: '无法获取校验和清单' })
    const { runner, refreshCalls } = makeRunner({ supervisor: supervisor.supervisor, installer })

    const outcome = await runner.run(undefined)
    expect(outcome.ready).toBe(false)
    expect(outcome.steps).toHaveLength(1)
    expect(outcome.steps[0]!.status).toBe('failed')
    expect(outcome.steps[0]!.detail).toMatch(/校验和清单/)
    expect(supervisor.calls).toEqual(['resolveBinary'])
    expect(refreshCalls).toHaveLength(0)
  })

  it('安装报告成功但文件不存在 → 复核失败（不相信返回值）', async () => {
    const supervisor = fakeSupervisor({ resolveFails: '未找到' })
    const { installer } = fakeInstaller({ write: false })
    const { runner } = makeRunner({ supervisor: supervisor.supervisor, installer })

    const outcome = await runner.run(undefined)
    expect(outcome.ready).toBe(false)
    expect(outcome.steps.map(step => step.title)).toContain('校验安装结果')
    expect(supervisor.calls).toEqual(['resolveBinary'])
  })

  it('显式配置的 binaryPath 不存在 → 报配置错误，不擅自下载到别处', async () => {
    const supervisor = fakeSupervisor({ resolveFails: '配置的 binaryPath 不存在：D:/nope/wb2a-server.exe' })
    const { installer, calls } = fakeInstaller()
    const { runner } = makeRunner({
      supervisor: supervisor.supervisor,
      installer,
      binaryPath: 'D:/nope/wb2a-server.exe',
    })

    const outcome = await runner.run(undefined)
    expect(outcome.ready).toBe(false)
    expect(calls).toHaveLength(0) // 关键：没有下载
    expect(outcome.steps[0]!.detail).toMatch(/显式指定的路径/)
  })
})

describe('SetupRunner：账号缺失', () => {
  it('未指定 realm 时不猜域，如实要求先选版本', async () => {
    const root = tempRoot()
    const loginCalls: Array<Realm | undefined> = []
    const { runner } = makeRunner({
      root,
      store: emptyStore(root),
      supervisor: fakeSupervisor().supervisor,
      login: async (realm) => { loginCalls.push(realm); return { ok: false, detail: 'x' } },
    })

    const outcome = await runner.run(undefined)
    expect(outcome.ready).toBe(false)
    // 编排层把 undefined 原样交给登录动作（由命令层决定如何询问），不代它选 cn。
    expect(loginCalls).toEqual([undefined])
    expect(outcome.steps.map(step => step.title)).toEqual(['定位网关可执行文件', '登录账号'])
  })

  it('登录成功后走 restart（网关只在启动时扫 auths/）', async () => {
    const root = tempRoot()
    const store = emptyStore(root)
    const supervisor = fakeSupervisor()
    const { runner } = makeRunner({
      root,
      store,
      supervisor: supervisor.supervisor,
      login: async () => {
        // 真实登录会落盘；这里模拟同样的最终形态，然后由编排层重新扫描目录。
        writeFileSync(join(root, 'auths', 'workbuddy-oneid_new.json'), JSON.stringify({
          account: { uid: 'oneid_new', nickname: '新号', enterpriseId: '' },
          auth: { accessToken: 'x', refreshToken: 'y', expiresAt: 1, domain: 'copilot.tencent.com', realm: 'cn' },
        }))
        return { ok: true, uid: 'oneid_new' }
      },
    })

    const outcome = await runner.run('cn')
    expect(outcome.ready).toBe(true)
    expect(supervisor.calls).toEqual(['resolveBinary', 'restart'])
    const loginStep = outcome.steps.find(step => step.title === '登录账号')!
    expect(loginStep.status).toBe('ok')
    expect(loginStep.detail).toContain('新号')
    // 断言目录最终形态：确实有一个启用中的凭证文件。
    expect(readdirSync(join(root, 'auths')).filter(name => /^workbuddy.*\.json$/.test(name))).toHaveLength(1)
  })

  it('登录"成功"但没有写出启用凭证 → 复核失败（不轻信登录动作的回报）', async () => {
    const root = tempRoot()
    const { runner } = makeRunner({
      root,
      store: emptyStore(root),
      supervisor: fakeSupervisor().supervisor,
      login: async () => ({ ok: true, uid: 'oneid_new' }),
    })

    const outcome = await runner.run('cn')
    expect(outcome.ready).toBe(false)
    const loginStep = outcome.steps.find(step => step.title === '登录账号')!
    expect(loginStep.status).toBe('failed')
    expect(loginStep.detail).toMatch(/仍没有启用中的凭证文件/)
  })

  it('登录失败 → 原因原样透出，且不启动网关', async () => {
    const root = tempRoot()
    const supervisor = fakeSupervisor()
    const { runner } = makeRunner({
      root,
      store: emptyStore(root),
      supervisor: supervisor.supervisor,
      login: async () => ({ ok: false, detail: '等待授权超时（60 秒内上游始终未确认登录）。' }),
    })

    const outcome = await runner.run('cn')
    expect(outcome.ready).toBe(false)
    expect(outcome.steps.find(step => step.title === '登录账号')!.detail).toMatch(/等待授权超时/)
    expect(supervisor.calls).toEqual(['resolveBinary'])
  })

  it('全部账号处于禁用态时视为"没有账号"（会触发登录）', async () => {
    const root = tempRoot()
    const auths = join(root, 'auths')
    mkdirSync(auths, { recursive: true })
    writeFileSync(join(root, 'config.json'), JSON.stringify({ auth_dir: './auths' }))
    // 只留禁用态文件：网关看不见它，因此必须走登录。
    writeFileSync(join(auths, 'workbuddy-oneid_1.json.disabled'), JSON.stringify({
      account: { uid: 'oneid_1', nickname: 'alpha', enterpriseId: '' },
      auth: { accessToken: 'x', refreshToken: 'y', expiresAt: 1, domain: 'copilot.tencent.com', realm: 'cn' },
    }))
    const store = new AccountStore({ config: { ...DEFAULT_CONFIG, repoPath: root }, logger: silentLogger })
    let loginCalled = false
    const { runner } = makeRunner({
      root,
      store,
      supervisor: fakeSupervisor().supervisor,
      login: async () => { loginCalled = true; return { ok: false, detail: '停在这里' } },
    })

    await runner.run('cn')
    expect(loginCalled).toBe(true)
  })
})

describe('SetupRunner：网关与模型', () => {
  it('网关有响应但 healthy=0 → ready=false，并说明可能只是冷却', async () => {
    const supervisor = fakeSupervisor({
      status: { state: 'unhealthy', health: { healthy: 0, total: 1, raw: {} } },
    })
    const { runner, refreshCalls } = makeRunner({ supervisor: supervisor.supervisor })

    const outcome = await runner.run(undefined)
    expect(outcome.ready).toBe(false)
    const step = outcome.steps.find(item => item.title === '启动网关')!
    expect(step.status).toBe('failed')
    expect(step.detail).toMatch(/没有可用账号/)
    // 模型目录仍会刷新一次（有 TTL 缓存，值得一试）。
    expect(refreshCalls).toHaveLength(1)
    expect(outcome.steps.at(-1)!.status).toBe('ok')
  })

  it('网关启动失败 → 带上 stderr 尾部，不刷新模型', async () => {
    const supervisor = fakeSupervisor({
      status: { state: 'failed', lastError: '网关进程意外退出（exitCode=1 signal=null）', recentStderr: 'panic: boom' },
    })
    const { runner, refreshCalls } = makeRunner({ supervisor: supervisor.supervisor })

    const outcome = await runner.run(undefined)
    expect(outcome.ready).toBe(false)
    const step = outcome.steps.find(item => item.title === '启动网关')!
    expect(step.detail).toMatch(/exitCode=1/)
    expect(step.detail).toMatch(/panic: boom/)
    expect(refreshCalls).toHaveLength(0)
  })

  it('模型目录刷新失败不算致命（网关本体可用就该报 ready）', async () => {
    const { runner } = makeRunner({
      supervisor: fakeSupervisor().supervisor,
      refreshModels: async () => { throw new Error('GET /v1/models 返回 HTTP 503') },
    })

    const outcome = await runner.run(undefined)
    expect(outcome.ready).toBe(true)
    const step = outcome.steps.at(-1)!
    expect(step.title).toBe('同步模型目录')
    expect(step.status).toBe('failed')
    // 失败原因里要给出下一步动作，而不是只报错。
    expect(step.detail).toMatch(/重启 dsh/)
  })

  it('没有 subprocess 服务时，前两步的成果照常汇报（不假装能启动）', async () => {
    const { runner } = makeRunner()
    const outcome = await runner.run(undefined)
    expect(outcome.ready).toBe(false)
    expect(outcome.steps.map(step => step.title)).toContain('启动网关')
    expect(outcome.steps.find(step => step.title === '启动网关')!.detail).toMatch(/subprocess 服务不可用/)
  })
})

describe('renderSetupReport', () => {
  it('逐条列出步骤、失败项打叉，并在未就绪时给出下一步', async () => {
    const root = tempRoot()
    const { runner } = makeRunner({
      root,
      store: emptyStore(root),
      supervisor: fakeSupervisor().supervisor,
      login: async () => ({ ok: false, detail: '等待授权超时' }),
    })
    const outcome = await runner.run('cn')
    const text = renderSetupReport(outcome)
    expect(text).toContain('✓ 1. 定位网关可执行文件')
    expect(text).toContain('✗ 2. 登录账号')
    expect(text).toContain('等待授权超时')
    expect(text).toContain('尚未就绪：请按上面标 ✗ 的步骤处理后重跑 /wb2api-setup。')
  })

  it('全部就绪时给出「可以开始对话」的结论', async () => {
    const { runner } = makeRunner({ supervisor: fakeSupervisor().supervisor })
    const text = renderSetupReport(await runner.run(undefined))
    expect(text).toContain('全部就绪')
    expect(text).toContain('2 个模型')
  })
})
