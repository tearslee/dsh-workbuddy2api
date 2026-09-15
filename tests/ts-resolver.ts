import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * 源码用 NodeNext 解析，所有相对导入都带 `.js` 后缀（TS 要求），但磁盘上只有 `.ts`。
 * 测试直接跑 `src/*.ts` 源码而不预编译，因此需要把 `./x.js` 指回 `./x.ts`。
 *
 * 直接算出绝对路径并校验存在性，不依赖 vite 的二次解析 —— `this.resolve()` 对
 * 「不存在的 .js」不会自动回退到 .ts。
 *
 * @returns vite 插件。
 */
export function tsFromJsSpecifier() {
  return {
    name: 'ts-from-js-specifier',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (importer === undefined) return null
      if (!source.endsWith('.js')) return null
      if (!source.startsWith('./') && !source.startsWith('../')) return null
      const candidate = resolve(dirname(importer), source.slice(0, -3) + '.ts')
      return existsSync(candidate) ? candidate : null
    },
  }
}
