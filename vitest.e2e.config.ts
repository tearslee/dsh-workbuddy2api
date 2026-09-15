import { defineConfig } from 'vitest/config'
import { tsFromJsSpecifier } from './tests/ts-resolver.js'

export default defineConfig({
  plugins: [tsFromJsSpecifier()],
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    environment: 'node',
    // 真实对话可能耗时较久（含工具调用轮）。
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // 集成测试串行，避免并发打爆账号池的在途上限。
    fileParallelism: false,
  },
  resolve: { extensions: ['.ts', '.js', '.mjs', '.json'] },
})
