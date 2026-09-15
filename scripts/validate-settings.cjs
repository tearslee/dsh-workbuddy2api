// 用 dsh 自带的 yaml 解析器校验迁移结果，确保是合法 YAML 且语义正确。
const fs = require('fs')
const YAML = require('C:/Users/Administrator/AppData/Local/Programs/PhpWebStudy-Data/env/node/node_modules/@deepseek-ai/dsh/node_modules/yaml')

const target = process.argv[2]
const text = fs.readFileSync(target, 'utf8')
try {
  const doc = YAML.parse(text)
  console.log('YAML PARSE: OK')
  console.log('top-level keys: ' + Object.keys(doc).join(', '))
  console.log('agent-default-model = ' + JSON.stringify(doc['agent-default-model']))
  console.log('llm-pi-ai present = ' + ('llm-pi-ai' in doc))
  console.log('subagent allowedModels count = ' + (doc['subagent-model-selection']?.allowedModels?.length ?? 'n/a'))
  console.log('permission.defaultPreset = ' + (doc.permission?.defaultPreset ?? 'n/a'))
} catch (error) {
  console.log('YAML PARSE FAILED: ' + error.message)
  process.exitCode = 1
}
