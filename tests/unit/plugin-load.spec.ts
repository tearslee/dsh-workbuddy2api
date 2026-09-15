/**
 * 插件装载集成测试：把**构建产物**装进一个真实的 cordis Context，
 * 用真实的 `@deepseek-ai/dsh-llm` 运行时注册 provider 与适配器。
 *
 * 这一层补上了单元测试够不到的地方：
 *  - `ctx.llm.registerConfigurableProviders()` / `registerAdapter()` 的真实校验
 *    （`info.id === provider`、`DUPLICATE_ADAPTER` 冲突检测）；
 *  - `ctx.commands.register()` 的命令清单；
 *  - `Config` schema 能否被 `toJSON()`（settings 注册的硬要求）。
 *
 * **为什么整个文件共用同一个 Context**：cordis 的根服务注册表是**进程级共享**的，
 * 第二次 `ctx.provide('llm', ...)` 会报 `service "llm" has been registered at <root>`；
 * 而 `ctx.isolate(name, label)` 对**相同 label 会合并作用域**，也救不了同一文件内的
 * 多次建树。vitest 默认按文件隔离模块，因此「一个文件一个 Context」是唯一干净的切法；
 * `plugin-degrade.spec.ts` 单独覆盖需要另建一棵树的降级路径。
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const DSH_AI = 'C:/Users/Administrator/AppData/Local/Programs/PhpWebStudy-Data/env/node/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

/** 把内核包解析到实际文件路径（ESM 不接受裸目录）。 */
function resolveKernel(name: string): string {
  const main = (require(join(DSH_AI, name, 'package.json')) as { main: string }).main
  return pathToFileURL(join(DSH_AI, name, main)).href
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 造一个最小的 subprocess 替身（本测试不需要真进程）。 */
function fakeSubprocess() {
  return {
    resolveExecutable: async (command: string) => { throw new Error(`not found: ${command}`) },
    terminalEnvironment: async () => ({ platform: 'windows' as const }),
    spawn: () => { throw new Error('spawn not expected in this test') },
    spawnTerminal: async () => { throw new Error('unused') },
  }
}

interface PluginExports {
  name: string
  inject: string[]
  Config: { toJSON(): unknown }
  apply(ctx: unknown, config?: unknown): void
}

let cordis: typeof import('@deepseek-ai/cordis')
let llm: typeof import('@deepseek-ai/dsh-llm')
let plugin: PluginExports
let ctx: {
  provide(name: string, value: unknown): void
  llm: {
    listProviders(): Array<{ id: string; name: string }>
    listConfigurableProviders(): Array<{ provider: string; settingsNs: string }>
    registerAdapter(providers: string[], adapter: unknown): unknown
  }
  commands: { list(agent: unknown): Array<{ name: string }> }
  stop(): Promise<void>
}

beforeAll(async () => {
  cordis = await import(resolveKernel('cordis'))
  llm = await import(resolveKernel('dsh-llm'))
  const commands = await import(resolveKernel('dsh-commands'))
  plugin = await import(pathToFileURL(join(projectRoot, 'lib', 'index.js')).href) as unknown as PluginExports

  ctx = new cordis.Context() as unknown as typeof ctx
  // 服务注册表是**每个根 Context 独立**的，所以一个文件建一棵树即可。
  //
  // 注意：`LlmRuntime` / `CommandRuntime` 都是 cordis `Service` 子类，**构造时就以
  // 静态 `provide` 名把自己注册进传入的 ctx**。因此构造之后**不能**再对同一名字调
  // `ctx.provide()` —— 那会报 `service "X" has been registered at <root>`。
  // 只有非 Service 的替身（subprocess）才需要手工 provide。
  void new llm.LlmRuntime(ctx as never)
  void new commands.CommandRuntime(ctx as never)
  ctx.provide('subprocess', fakeSubprocess())

  // autoStart: false —— 测试不拉起真实进程；端口用一个必然空闲的高端口。
  plugin.apply(ctx, { autoStart: false, baseURL: 'http://127.0.0.1:59993/v1' })
})

describe('插件装载（真实 cordis + dsh-llm）', () => {
  it('插件导出面符合 dsh 插件契约', () => {
    expect(plugin.name).toBe('workbuddy2api')
    expect(plugin.inject).toEqual(['llm', 'subprocess', 'commands'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('Config schema 可被 toJSON()（settings.describe 的硬要求）', () => {
    // 传裸函数会让 settings.describe() 抛
    // `registration.schema.toJSON is not a function`，进而拖垮整个设置页。
    expect(typeof plugin.Config.toJSON).toBe('function')
    const json = plugin.Config.toJSON()
    expect(json).toBeTypeOf('object')
    expect(Object.keys(json as object).length).toBeGreaterThan(0)
  })

  it('provider 成功注册进真实 LlmRuntime', () => {
    const providers = ctx.llm.listProviders()
    expect(providers.map(provider => provider.id)).toContain('workbuddy2api')
    // 契约要求 name 非空，且 providerInfo().id === 注册的路由名。
    expect(providers.find(provider => provider.id === 'workbuddy2api')?.name.length).toBeGreaterThan(0)
  })

  it('可配置 provider 目录里也有该路由（模型设置页据此展示）', () => {
    const entry = ctx.llm.listConfigurableProviders().find(item => item.provider === 'workbuddy2api')
    expect(entry).toBeDefined()
    expect(entry?.settingsNs).toBe('llm-workbuddy2api')
  })

  it('四个管理命令都注册成功', () => {
    const listed = ctx.commands.list({} as never).map(descriptor => descriptor.name)
    for (const expected of ['wb2api-status', 'wb2api-start', 'wb2api-restart', 'wb2api-login']) {
      expect(listed).toContain(expected)
    }
  })

  it('同一路由重复注册被拒（迁移冲突的可检出行径）', () => {
    // settings.yaml 里残留旧 provider 时，dsh 启动就会走到这条路径。
    // 真实错误：code = `DUPLICATE_ADAPTER`，人类可读消息为
    // `an adapter for provider "workbuddy2api" is already registered`
    // —— 消息里**不含** code 字样，所以迁移排障要认 code 或这句英文。
    class Dummy extends llm.LlmAdapter {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<never> { throw new Error('unused') }
    }
    let caught: unknown
    try {
      ctx.llm.registerAdapter(['workbuddy2api'], new Dummy())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('DUPLICATE_ADAPTER')
    expect((caught as Error).message).toMatch(/already registered/)
  })

  it('真实基类提供插件覆盖的全部方法（不只是 tsc 层面兼容）', () => {
    for (const method of ['providerInfo', 'listModels', 'resolveModel', 'prepareCall']) {
      expect(typeof (llm.LlmAdapter.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })
})
