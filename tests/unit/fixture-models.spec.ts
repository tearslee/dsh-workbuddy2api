/**
 * 针对**真实网关响应样本**的映射测试。
 *
 * `tests/fixtures/v1-models.sample.json` 是从运行中的网关 `GET /v1/models`
 * 原样抓取的响应体（37 个模型：16 个 `cn:` + 21 个 `global:`）。用它做回归，
 * 可以锁住上游字段的真实形状 —— 包括那些只能从实际数据里看出来的性质：
 *
 *  - `global:` 分支没有 `max_output_tokens`，`context_length` 恒为 131072；
 *  - CN 侧 `reasoning_supported_efforts` 里有 `medium` 这种 settings.yaml
 *    年代从未手写过的档位；
 *  - `supports_images` 只在支持时出现。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mapModelCatalog } from '../../src/models.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const sample = JSON.parse(readFileSync(join(fixturesDir, 'v1-models.sample.json'), 'utf8')) as {
  object: string
  data: Array<Record<string, unknown>>
}

const stripCn = mapModelCatalog(sample, 'strip-cn')
const keep = mapModelCatalog(sample, 'keep')

describe('真实 /v1/models 样本', () => {
  it('样本本身结构符合 OpenAI 列表格式', () => {
    expect(sample.object).toBe('list')
    expect(Array.isArray(sample.data)).toBe(true)
    expect(sample.data.length).toBeGreaterThan(0)
  })

  it('strip-cn：剥掉 cn: 前缀，保留 global: 前缀', () => {
    expect(stripCn.length).toBe(sample.data.length)
    expect(stripCn.some(model => model.id.startsWith('cn:'))).toBe(false)
    expect(stripCn.filter(model => model.realm === 'global').every(model => model.id.startsWith('global:'))).toBe(true)
    expect(stripCn.some(model => model.id === 'deepseek-v4.1-flash')).toBe(true)
  })

  it('keep：两种前缀都保留', () => {
    expect(keep.length).toBe(sample.data.length)
    expect(keep.some(model => model.id.startsWith('cn:'))).toBe(true)
    expect(keep.some(model => model.id.startsWith('global:'))).toBe(true)
  })

  it('每个模型都落到合法 id 与正的上下文窗口', () => {
    for (const model of stripCn) {
      expect(model.bareId.length).toBeGreaterThan(0)
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(['cn', 'global']).toContain(model.realm)
    }
  })

  it('CN 侧给出真实上下文窗口（不是占位 131072）', () => {
    const cn = stripCn.filter(model => model.realm === 'cn')
    expect(cn.length).toBeGreaterThan(0)
    expect(cn.some(model => model.contextWindow !== 131072)).toBe(true)
  })

  it('CN 侧给出 max_output_tokens', () => {
    const cn = stripCn.filter(model => model.realm === 'cn')
    expect(cn.some(model => model.maxOutputTokens !== undefined)).toBe(true)
  })

  it('上游已知局限：global 侧全部没有 max_output_tokens，窗口恒为 131072', () => {
    // 这不是插件的 bug，是上游 modelList() global 分支的硬编码
    // （handler.go 里 global 条目只写 context_length: 131072）。
    // 用断言锁住它，以便上游修复时立刻可见。
    const global = stripCn.filter(model => model.realm === 'global')
    expect(global.length).toBeGreaterThan(0)
    expect(global.every(model => model.maxOutputTokens === undefined)).toBe(true)
    expect(global.every(model => model.contextWindow === 131072)).toBe(true)
  })

  it('上游已知局限：global 侧不下发 supports_images', () => {
    const global = stripCn.filter(model => model.realm === 'global')
    expect(global.every(model => model.supportsImages === false)).toBe(true)
  })

  it('CN 侧有模型支持图片输入', () => {
    expect(stripCn.filter(model => model.realm === 'cn').some(model => model.supportsImages)).toBe(true)
  })

  it('档位解析正常，且 defaultEffort 必在 efforts 内', () => {
    const withEfforts = stripCn.filter(model => model.efforts.length > 0)
    expect(withEfforts.length).toBeGreaterThan(0)
    for (const model of stripCn) {
      if (model.defaultEffort !== undefined) {
        expect(model.efforts).toContain(model.defaultEffort)
      }
    }
  })

  it('实测数据里存在 settings.yaml 年代从未手写的 medium 档位', () => {
    // 手工维护元数据时漏掉这些档位是必然的 —— 正是本插件要消除的问题。
    const efforts = new Set(stripCn.flatMap(model => [...model.efforts]))
    expect(efforts.has('medium')).toBe(true)
  })

  it('没有重复 id（strip-cn 与 keep 都应成立）', () => {
    expect(new Set(stripCn.map(model => model.id)).size).toBe(stripCn.length)
    expect(new Set(keep.map(model => model.id)).size).toBe(keep.length)
  })

  it('两个 realm 存在同名模型时仍能共存（靠前缀区分）', () => {
    const cnBare = new Set(stripCn.filter(model => model.realm === 'cn').map(model => model.bareId))
    const shared = stripCn.filter(model => model.realm === 'global' && cnBare.has(model.bareId))
    expect(shared.length).toBeGreaterThan(0)
    // 同名但 id 不同：global 侧带前缀，因此不会互相覆盖。
    for (const model of shared) expect(model.id).toBe(`global:${model.bareId}`)
  })
})
