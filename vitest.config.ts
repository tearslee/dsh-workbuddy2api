import { defineConfig } from 'vitest/config'
import { tsFromJsSpecifier } from './tests/ts-resolver.js'

export default defineConfig({
  plugins: [tsFromJsSpecifier()],
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    environment: 'node',
  },
  // 显式声明扩展名，避免 vite 从 tsconfig 的 NodeNext 推断出错误的解析行为。
  resolve: { extensions: ['.ts', '.js', '.mjs', '.json'] },
})
