// 用 dsh 自带的 yaml 解析器校验 settings.yaml（或迁移后的成品）是合法 YAML，
// 且关键引用没有在迁移中丢失。
//
// 用法：node validate-settings.cjs <settings.yaml 路径>
//
// 解析器查找顺序：
//   1. 常规 require('yaml')（在插件/项目 node_modules 里能找到时）
//   2. dsh 安装目录下的 yaml（dsh 自身依赖它，必然存在）
// 两处都找不到就明确报"跳过校验"，而不是假装通过。

const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

const target = process.argv[2]
if (!target) {
  console.error('用法：node validate-settings.cjs <settings.yaml 路径>')
  process.exit(2)
}

/** 依次尝试若干解析器来源，返回第一个可用的 yaml 模块。 */
function loadYaml() {
  try {
    return require('yaml')
  } catch {
    // 继续找 dsh 自带的那份。
  }
  const candidates = []
  // DSH_* 环境变量由 dsh 启动的子进程可见；其次按常见安装位置猜。
  if (process.env.DSH_HOME) candidates.push(path.join(process.env.DSH_HOME, 'node_modules', 'yaml'))
  const nodeDir = path.dirname(process.execPath)
  candidates.push(
    path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'yaml'),
    path.join(nodeDir, '..', 'app', 'nodejs', 'v26.3.0', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'yaml'),
  )
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        return createRequire(path.join(candidate, 'package.json'))('yaml')
      } catch {
        // 试下一个。
      }
    }
  }
  return undefined
}

const YAML = loadYaml()
if (YAML === undefined) {
  console.log('SKIP: 找不到 yaml 解析器，未做语法校验。')
  console.log('      可先 cd 到 dsh 安装目录，或用 `dsh --profile web --dump-config` 校验。')
  process.exit(0)
}

const text = fs.readFileSync(target, 'utf8')
let doc
try {
  doc = YAML.parse(text)
} catch (error) {
  console.log('YAML PARSE FAILED: ' + error.message)
  process.exit(1)
}

console.log('YAML PARSE: OK')
console.log('top-level keys: ' + Object.keys(doc).join(', '))

// 迁移后必须保留的引用：provider id 不变，所以这些仍然应该指向 workbuddy2api。
const defaultProvider = doc['agent-default-model']?.provider
console.log('agent-default-model.provider = ' + (defaultProvider ?? '(未设置)'))
const allowed = doc['subagent-model-selection']?.allowedModels
console.log('subagent allowedModels count = ' + (Array.isArray(allowed) ? allowed.length : 'n/a'))
console.log('llm-pi-ai present = ' + ('llm-pi-ai' in doc))

let failed = false
if (defaultProvider !== 'workbuddy2api') {
  console.log('WARN: agent-default-model.provider 不是 workbuddy2api —— 若这不是本意，请检查迁移是否误删。')
}
if (!Array.isArray(allowed) || allowed.length === 0) {
  console.log('WARN: subagent-model-selection.allowedModels 为空 —— 若这不是本意，请检查迁移是否误删。')
}
if ('llm-pi-ai' in doc && doc['llm-pi-ai']?.providers?.workbuddy2api !== undefined) {
  console.log('NOTE: llm-pi-ai.providers.workbuddy2api 仍存在 —— 插件会因此只降级不生效。')
  failed = true
}
process.exit(failed ? 1 : 0)
