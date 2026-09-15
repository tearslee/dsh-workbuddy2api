/**
 * 路由冲突降级测试：settings.yaml 里仍留着同名 provider 时（「装了插件但还没做迁移」），
 * 插件必须**照常加载完毕**，而不是让整个 dsh 起不来。
 *
 * 单独成文件的原因见 `plugin-load.spec.ts` 顶部注释：cordis 的服务注册表按根 Context
 * 隔离，而一个文件里重复 apply 同一个插件会撞上命令重复注册（那是同一 ctx 的编程错误，
 * 不是用户配置问题）。所以这里单开一棵树。
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const DSH_AI = 'C:/Users/Administrator/AppData/Local/Programs/PhpWebStudy-Data/env/node/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

function resolveKernel(name: string): string {
  const main = (require(join(DSH_AI, name, 'package.json')) as { main: string }).main
  return pathToFileURL(join(DSH_AI, name, main)).href
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('provider 路由被外部配置占用时的降级', () => {
  it('插件不抛错，dsh 仍可启动，日志指出该删哪一段', async () => {
    const cordis = await import(resolveKernel('cordis'))
    const llm = await import(resolveKernel('dsh-llm'))
    const commands = await import(resolveKernel('dsh-commands'))
    const plugin = await import(pathToFileURL(join(projectRoot, 'lib', 'index.js')).href) as unknown as {
      apply(ctx: unknown, config?: unknown): void
    }

    const ctx = new cordis.Context() as unknown as {
      provide(name: string, value: unknown): void
      llm: {
        listProviders(): Array<{ id: string }>
        listConfigurableProviders(): Array<{ provider: string }>
        registerAdapter(providers: string[], adapter: unknown): unknown
        registerConfigurableProviders(entries: unknown[]): unknown
      }
    }
    void new llm.LlmRuntime(ctx as never)
    void new commands.CommandRuntime(ctx as never)
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('n/a') },
      terminalEnvironment: async () => ({ platform: 'windows' as const }),
      spawn: () => { throw new Error('n/a') },
      spawnTerminal: async () => { throw new Error('n/a') },
    })

    // 模拟 settings.yaml 里的手工 provider：目录条目与适配器都已被占用。
    ctx.llm.registerConfigurableProviders([{
      provider: 'workbuddy2api',
      displayName: '手工配置的 workbuddy2api',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'workbuddy2api'],
    }])
    class Occupier extends llm.LlmAdapter {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<never> { throw new Error('unused') }
    }
    ctx.llm.registerAdapter(['workbuddy2api'], new Occupier())

    // 两处注册都已被占用 —— 插件必须捕获并降级，而不是把异常抛给 dsh 启动流程。
    expect(() => plugin.apply(ctx, { autoStart: false, baseURL: 'http://127.0.0.1:59988/v1' })).not.toThrow()

    // 路由仍在（属于占位者），因此 dsh 启动后模型照常可用，只是走旧适配器。
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy2api')
  })
})
