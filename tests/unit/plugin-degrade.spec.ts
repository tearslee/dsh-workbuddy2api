/**
 * 降级路径测试：settings / subprocess 服务缺失时插件仍应加载。
 *
 * 单独成文件的原因见 `plugin-load.spec.ts` 顶部注释：cordis 的根服务注册表是
 * 进程级共享的，一个文件只能干净地建一棵树。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hasKernel, resolveKernel } from '../kernel-resolver.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// 需要真实内核才能建 cordis 树：探测不到就跳过，避免别人的 checkout 红一片。
describe.skipIf(!hasKernel())('插件降级路径', () => {
  it('settings 与 subprocess 都缺失时：不崩溃，provider 仍注册', async () => {
    const cordis = await import(resolveKernel('cordis'))
    const llm = await import(resolveKernel('dsh-llm'))
    const commands = await import(resolveKernel('dsh-commands'))
    const plugin = await import(pathToFileURL(join(projectRoot, 'lib', 'index.js')).href) as unknown as {
      apply(ctx: unknown, config?: unknown): void
    }

    const ctx = new cordis.Context() as unknown as {
      provide(name: string, value: unknown): void
      llm: { listProviders(): Array<{ id: string }> }
    }
    // Service 子类构造时即自注册（并以静态 provide 名登记），因此**不要**再手工 provide。
    // 注册表按根 Context 隔离，一个文件一棵树即可。
    void new llm.LlmRuntime(ctx as never)
    void new commands.CommandRuntime(ctx as never)
    // 刻意不提供 settings 与 subprocess。

    // 插件加载不该抛错 —— 缺 settings 只是少一个 namespace 地址，
    // 缺 subprocess 只是无法托管进程。
    expect(() => plugin.apply(ctx, { autoStart: false, baseURL: 'http://127.0.0.1:59990/v1' })).not.toThrow()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy2api')
  })
})
