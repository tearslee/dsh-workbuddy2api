/**
 * dsh 内核包（`@deepseek-ai/dsh-*`）定位，供装载类测试使用。
 *
 * **为什么不硬编码路径**：本机安装位置带 Windows 用户名与软件栈信息，写进测试
 * 等于把环境指纹提交进公开仓库；同时别人的 checkout 必然找不到该路径，测试全红。
 * 这里改为按常见安装布局探测，探测不到就让调用方**跳过**用例。
 *
 * 查找顺序（第一个命中 `dsh-llm` 的胜出）：
 *  1. `DSH_KERNEL_DIR` 环境变量 —— 显式覆盖，CI 或不常见布局用；
 *  2. `<node 可执行文件目录>/node_modules` —— npm 全局安装 dsh 的布局；
 *  3. `<node 可执行文件目录>/../lib/node_modules` —— POSIX 全局布局；
 *  4. `$DSH_HOME/node_modules` —— dsh 家目录下的依赖。
 *
 * @module tests/kernel-resolver
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** 探测某个 node_modules 根下是否装着 dsh 内核；命中则返回内核 `@deepseek-ai` 目录。 */
function probe(nodeModulesRoot: string): string | undefined {
  const dir = join(nodeModulesRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  return existsSync(join(dir, 'dsh-llm', 'package.json')) ? dir : undefined
}

let cached: string | undefined
let probed = false

/**
 * 内核 `@deepseek-ai` 包目录的绝对路径（结果进程内缓存）。
 *
 * @returns 找到的目录；所有候选都落空时返回 `undefined`。
 */
export function kernelDir(): string | undefined {
  if (probed) return cached
  probed = true

  const roots: string[] = []
  const explicit = process.env.DSH_KERNEL_DIR
  if (typeof explicit === 'string' && explicit.length > 0) roots.push(explicit)

  const nodeDir = dirname(process.execPath)
  roots.push(join(nodeDir, 'node_modules'))
  roots.push(join(nodeDir, '..', 'lib', 'node_modules'))

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) roots.push(join(home, 'node_modules'))

  for (const root of roots) {
    const found = probe(root)
    if (found !== undefined) {
      cached = found
      return found
    }
  }
  return undefined
}

/** 内核是否可用 —— 决定需要真实内核的用例跑还是跳过。 */
export function hasKernel(): boolean {
  return kernelDir() !== undefined
}

/**
 * 把内核包解析成可直接 `import()` 的文件 URL（ESM 不接受裸目录）。
 *
 * @param name - 内核包名，如 `cordis` / `dsh-llm` / `dsh-commands`。
 * @returns 该包入口的 `file://` URL。
 * @throws 未找到内核时抛错；调用方应先用 {@link hasKernel} 判断。
 */
export function resolveKernel(name: string): string {
  const dir = kernelDir()
  if (dir === undefined) {
    throw new Error(
      '未找到 dsh 内核包目录。可设置 DSH_KERNEL_DIR 指向 '
      + '<dsh 安装目录>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai 后重试。',
    )
  }
  const main = (require(join(dir, name, 'package.json')) as { main: string }).main
  return pathToFileURL(join(dir, name, main)).href
}
