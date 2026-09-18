import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GatewaySupervisor } from '../../src/gateway-supervisor.js'
import { resolveConfig } from '../../src/config.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** 起一个真正的 HTTP 服务当假网关，让探活走完整网络路径。 */
async function startFakeGateway(handler: (path: string) => { status: number; body: string }): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const result = handler(request.url ?? '/')
    response.writeHead(result.status, { 'content-type': 'application/json' })
    response.end(result.body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

/** 构造一个只记录调用的假 subprocess 服务。 */
function makeSubprocess(behavior: { exitImmediately?: boolean } = {}): {
  runtime: SubprocessRuntime
  spawns: Array<{ argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv | undefined }>
  terminateCalls: () => number
} {
  const spawns: Array<{ argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv | undefined }> = []
  let terminated = 0
  const runtime = {
    resolveExecutable: async (command: string) => {
      throw new Error(`not found: ${command}`)
    },
    terminalEnvironment: async () => ({ platform: 'windows' as const }),
    spawn: (spec: { argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }) => {
      spawns.push({ argv: spec.argv, cwd: spec.cwd, env: spec.env })
      let resolveDone: (value: { exitCode: number | null; signal: null }) => void = () => {}
      const done = new Promise<{ exitCode: number | null; signal: null }>(resolve => { resolveDone = resolve })
      if (behavior.exitImmediately === true) queueMicrotask(() => resolveDone({ exitCode: 1, signal: null }))
      const handle = {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        done,
        terminate: () => { terminated += 1; resolveDone({ exitCode: 0, signal: null }) },
        waitForExit: async () => true,
      } as unknown as SubprocessHandle
      return handle
    },
    spawnTerminal: async () => { throw new Error('unused') },
  } as unknown as SubprocessRuntime
  return { runtime, spawns, terminateCalls: () => terminated }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {})
})

describe('GatewaySupervisor.probe', () => {
  it('解析 /healthz 的 healthy / total / realm_servable', async () => {
    const gateway = await startFakeGateway(() => ({
      status: 200,
      body: JSON.stringify({ healthy: 1, total: 2, service: 'workbuddy2api', realm_servable: { cn: true, global: false } }),
    }))
    cleanups.push(gateway.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const health = await supervisor.probe()
    expect(health?.healthy).toBe(1)
    expect(health?.total).toBe(2)
    expect(health?.service).toBe('workbuddy2api')
    expect(health?.realmServable).toEqual({ cn: true, global: false })
  })

  it('端口无监听时返回 undefined（不是错误）', async () => {
    const { runtime } = makeSubprocess()
    // 用一个必然空闲的高端口。
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ baseURL: 'http://127.0.0.1:59999/v1' }),
      subprocess: runtime,
      logger: silentLogger,
    })
    expect(await supervisor.probe()).toBeUndefined()
  })

  it('端口被非网关程序占用时抛明确错误（而非静默失败）', async () => {
    const other = await startFakeGateway(() => ({ status: 404, body: 'nope' }))
    cleanups.push(other.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ baseURL: `http://127.0.0.1:${other.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await expect(supervisor.probe()).rejects.toThrow(/端口可能被其他程序占用/)
  })

  it('/healthz 返回非 JSON 时同样判定为端口被占用', async () => {
    const other = await startFakeGateway(() => ({ status: 200, body: '<html>hello</html>' }))
    cleanups.push(other.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ baseURL: `http://127.0.0.1:${other.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await expect(supervisor.probe()).rejects.toThrow(/端口可能被其他程序占用/)
  })
})

describe('GatewaySupervisor.start', () => {
  it('已有健康网关时直接复用，不重复 spawn', async () => {
    const gateway = await startFakeGateway(() => ({ status: 200, body: JSON.stringify({ healthy: 1, total: 1 }) }))
    cleanups.push(gateway.close)
    const { runtime, spawns } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const status = await supervisor.start()
    expect(status.state).toBe('external')
    expect(spawns).toHaveLength(0)
  })

  it('binaryPath 不存在时报错并指出配置项', async () => {
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ baseURL: 'http://127.0.0.1:59998/v1', binaryPath: 'D:/nope/missing.exe' }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await expect(supervisor.start()).rejects.toThrow(/binaryPath 不存在/)
  })

  it('spawn 后把显式 env 与工作目录传给子进程（子进程环境被 dsh 清洗）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb2api-'))
    const binary = join(dir, 'wb2a-server.exe')
    writeFileSync(binary, '')
    // exitImmediately：假进程立刻退出，让 waitForHealth 尽快收敛，
    // 否则会走满 30s 的就绪轮询预算。
    const { runtime, spawns } = makeSubprocess({ exitImmediately: true })
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({
        baseURL: 'http://127.0.0.1:59997/v1',
        binaryPath: binary,
        workingDir: dir,
        env: { WB2API_LOG: 'debug' },
      }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const status = await supervisor.start()
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.argv[0]).toBe(binary)
    expect(spawns[0]?.cwd).toBe(dir)
    // env 必须显式传入：dsh 会把凭据形名称与 DSH_* 从子进程环境里剥离。
    expect(spawns[0]?.env).toEqual({ WB2API_LOG: 'debug' })
    expect(status.state).toBe('failed')
    expect(status.lastError).toContain('意外退出')
  })

  it('工作目录缺省时回退到 repoPath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb2api-'))
    const binary = join(dir, 'wb2a-server.exe')
    writeFileSync(binary, '')
    const { runtime, spawns } = makeSubprocess({ exitImmediately: true })
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({
        baseURL: 'http://127.0.0.1:59996/v1',
        binaryPath: binary,
        repoPath: dir,
      }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await supervisor.start()
    expect(spawns[0]?.cwd).toBe(dir)
  })
})

describe('GatewaySupervisor.countAuthFiles', () => {
  it('统计 auths 下的 .json 文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb2api-'))
    mkdirSync(join(dir, 'auths'))
    writeFileSync(join(dir, 'auths', 'a.json'), '{}')
    writeFileSync(join(dir, 'auths', 'b.json'), '{}')
    writeFileSync(join(dir, 'auths', 'readme.txt'), 'x')
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ repoPath: dir }),
      subprocess: runtime,
      logger: silentLogger,
    })
    expect(supervisor.countAuthFiles()).toBe(2)
  })

  it('未配置 repoPath 或无 auths 目录时返回 0（回落到插件运行目录）', () => {
    const { runtime } = makeSubprocess()
    // 无 repoPath 时基准是插件运行目录 ~/.dsh/wb2api；本机若那里恰有凭证文件，
    // 断言会变得依赖环境，因此只断言「不抛错且是非负整数」。
    const count = new GatewaySupervisor({ config: resolveConfig({}), subprocess: runtime, logger: silentLogger }).countAuthFiles()
    expect(Number.isInteger(count)).toBe(true)
    expect(count).toBeGreaterThanOrEqual(0)
    const dir = mkdtempSync(join(tmpdir(), 'wb2api-'))
    expect(new GatewaySupervisor({ config: resolveConfig({ repoPath: dir }), subprocess: runtime, logger: silentLogger }).countAuthFiles()).toBe(0)
  })

  it('workingDir 优先于 repoPath（与网关真实 cwd 同源）', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb2api-repo-'))
    const work = mkdtempSync(join(tmpdir(), 'wb2api-work-'))
    mkdirSync(join(repo, 'auths'))
    mkdirSync(join(work, 'auths'))
    writeFileSync(join(repo, 'auths', 'repo.json'), '{}')
    writeFileSync(join(work, 'auths', 'w1.json'), '{}')
    writeFileSync(join(work, 'auths', 'w2.json'), '{}')
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ repoPath: repo, workingDir: work }),
      subprocess: runtime,
      logger: silentLogger,
    })
    // 数的是网关真正会读的那个目录，不是 repoPath。
    expect(supervisor.countAuthFiles()).toBe(2)
  })
})

describe('GatewaySupervisor 生命周期', () => {
  it('stop 会终止受管进程', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb2api-'))
    const binary = join(dir, 'wb2a-server.exe')
    writeFileSync(binary, '')
    const { runtime, terminateCalls } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ baseURL: 'http://127.0.0.1:59995/v1', binaryPath: binary }),
      subprocess: runtime,
      logger: silentLogger,
    })
    // 直接 start 会在探活轮询里等待；用 dispose 验证 terminate 被调用。
    void supervisor.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    await supervisor.dispose()
    expect(terminateCalls()).toBeGreaterThan(0)
  })

  it('stop 后再 status 为 stopped', async () => {
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ baseURL: 'http://127.0.0.1:59994/v1' }),
      subprocess: runtime,
      logger: silentLogger,
    })
    await supervisor.stop()
    expect(supervisor.status().state).toBe('stopped')
  })

  it('statusWithHealth 在网关可达时报告 health', async () => {
    const gateway = await startFakeGateway(() => ({ status: 200, body: JSON.stringify({ healthy: 3, total: 3 }) }))
    cleanups.push(gateway.close)
    const { runtime } = makeSubprocess()
    const supervisor = new GatewaySupervisor({
      config: resolveConfig({ baseURL: `http://127.0.0.1:${gateway.port}/v1` }),
      subprocess: runtime,
      logger: silentLogger,
    })
    const status = await supervisor.statusWithHealth()
    expect(status.health?.healthy).toBe(3)
    expect(status.port).toBe(gateway.port)
  })
})
