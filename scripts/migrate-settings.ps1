# 迁移脚本：删除 ~/.dsh/settings.yaml 里与插件冲突的 workbuddy2api provider 段
#
# 为什么需要这一步：
#   插件要注册 provider 路由 `workbuddy2api`。若 settings.yaml 里已有同名 provider
#   （llm-pi-ai.providers.workbuddy2api），插件会因路由已被占用而只降级不生效 ——
#   dsh 仍能启动，但模型走的是旧的手工配置，自动元数据不生效。
#
# 为什么必须由你在 dsh 停止时执行：
#   settings.yaml 是**热监听**的（dsh-settings-file 用 chokidar 监听）。在 dsh 运行中
#   删除该段会立刻生效，而插件那份 provider 要等重启才注册 —— 中间窗口里模型会不可用，
#   正在进行的会话可能直接失败。
#
# 用法：
#   1. 关闭 dsh
#   2. 在本脚本所在目录执行：  pwsh -File migrate-settings.ps1
#   3. 重新启动 dsh
#   4. 在 dsh 里执行 /wb2api-status 确认 provider 由插件接管

[CmdletBinding()]
param(
    # settings.yaml 路径；默认 ~/.dsh/settings.yaml
    [string]$SettingsPath = (Join-Path $env:USERPROFILE '.dsh\settings.yaml'),
    # 只预览不写入
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $SettingsPath)) {
    Write-Error "找不到 settings.yaml：$SettingsPath"
    exit 1
}

$lines = Get-Content $SettingsPath
Write-Host "读取：$SettingsPath（$($lines.Count) 行）"

# 定位 `llm-pi-ai:` 段，再在其下找到 `    workbuddy2api:` 子段，删到该子段结束。
# 采用缩进驱动的扫描而不是 YAML 解析：settings.yaml 里可能有 dsh 自己写的注释与顺序，
# 重写整个文件（序列化回来）会丢掉这些格式信息。
$llmPiAiIndex = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^llm-pi-ai:\s*$') { $llmPiAiIndex = $i; break }
}

if ($llmPiAiIndex -lt 0) {
    Write-Host "settings.yaml 里没有 llm-pi-ai: 段 —— 无需迁移。"
    exit 0
}

# llm-pi-ai 段范围：从它自己到下一个顶格（非缩进、非空、非注释）行为止。
$llmPiAiEnd = $lines.Count
for ($i = $llmPiAiIndex + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\S' -and $lines[$i] -notmatch '^#') { $llmPiAiEnd = $i; break }
}

# 在该段内找 `providers:` 与其下的 `workbuddy2api:` 子段（4 空格缩进）。
$workbuddyIndex = -1
for ($i = $llmPiAiIndex + 1; $i -lt $llmPiAiEnd; $i++) {
    if ($lines[$i] -match '^    workbuddy2api:\s*$') { $workbuddyIndex = $i; break }
}

if ($workbuddyIndex -lt 0) {
    Write-Host "llm-pi-ai 段里没有 workbuddy2api: 子段 —— 无需迁移。"
    exit 0
}

# workbuddy2api 段范围：到下一个 4 空格缩进的兄弟键，或 llm-pi-ai 段结束。
$workbuddyEnd = $llmPiAiEnd
for ($i = $workbuddyIndex + 1; $i -lt $llmPiAiEnd; $i++) {
    if ($lines[$i] -match '^    \S' -and $lines[$i] -notmatch '^    #') { $workbuddyEnd = $i; break }
}

$removedCount = $workbuddyEnd - $workbuddyIndex
Write-Host ""
Write-Host "将删除第 $($workbuddyIndex + 1) 到 $workbuddyEnd 行（共 $removedCount 行）："
Write-Host "----------------------------------------"
$lines[$workbuddyIndex..($workbuddyEnd - 1)] | Select-Object -First 8 | ForEach-Object { Write-Host "  $_" }
if ($removedCount -gt 8) { Write-Host "  ...（其余 $($removedCount - 8) 行）" }
Write-Host "----------------------------------------"

# 若 llm-pi-ai 段删完 provider 后只剩空壳，一并清掉空段。
#
# "空壳" 的判定必须排除 `providers:` 这一行本身 —— 它删掉 workbuddy2api 之后
# 就退化成 `  providers:`（无子键），那是空壳而不是"还有别的 provider"。
# 因此这里只看「除 providers: 行以外还有没有非空行」。
#
# 注意：留一个空的 `providers:` 其实也无害 —— dsh-llm-pi-ai 的 Config 会把
# `providers: null` / `{}` 都归一化成空映射（实测），等同于没配任何 provider。
# 这里清理只是为了让文件干净，不是因为空段会出错。
$providersLineIndex = -1
for ($i = $llmPiAiIndex + 1; $i -lt $llmPiAiEnd; $i++) {
    if ($lines[$i] -match '^  providers:\s*$') { $providersLineIndex = $i; break }
}

$remainingInSection = @()
for ($i = $llmPiAiIndex + 1; $i -lt $llmPiAiEnd; $i++) {
    if ($i -ge $workbuddyIndex -and $i -lt $workbuddyEnd) { continue }
    if ($i -eq $providersLineIndex) { continue }
    if ($lines[$i].Trim().Length -gt 0) { $remainingInSection += $lines[$i] }
}

$newLines = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -ge $workbuddyIndex -and $i -lt $workbuddyEnd) { continue }
    # 段内已无其他 provider：连 `llm-pi-ai:` 与它的 `providers:` 行一起删掉。
    if ($remainingInSection.Count -eq 0 -and $i -ge $llmPiAiIndex -and $i -lt $llmPiAiEnd) { continue }
    $newLines.Add($lines[$i])
}

# 顺带清掉因删除而残留的多余空行（原文件同一位置可能有空行分隔）。
$compacted = New-Object System.Collections.Generic.List[string]
foreach ($line in $newLines) {
    if ($line.Trim().Length -eq 0 -and $compacted.Count -gt 0 -and $compacted[$compacted.Count - 1].Trim().Length -eq 0) { continue }
    $compacted.Add($line)
}
$newLines = $compacted

if ($WhatIf) {
    Write-Host ""
    Write-Host "[WhatIf] 未写入。将保留 $($newLines.Count) 行（原 $($lines.Count) 行）。"
    exit 0
}

# 备份后再写：回滚就是把备份拷回来。
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$SettingsPath.bak-$stamp-migrate"
Copy-Item $SettingsPath $backup -Force
Write-Host ""
Write-Host "已备份到：$backup"

Set-Content -Path $SettingsPath -Value $newLines -Encoding utf8
Write-Host "已写入：$SettingsPath（$($newLines.Count) 行）"
if ($remainingInSection.Count -eq 0) {
    Write-Host "（llm-pi-ai 段已无其他 provider，整段一并删除）"
} else {
    Write-Host "（llm-pi-ai 段保留，你还有其他 provider 在那里）"
}
Write-Host ""
Write-Host "接下来的步骤："
Write-Host "  1. 启动 dsh"
Write-Host "  2. 在 dsh 里执行 /wb2api-status，确认不再出现「路由由外部配置占用」警告"
Write-Host "  3. 确认模型列表里的上下文窗口/思考档位与 GET /v1/models 一致"
Write-Host ""
Write-Host "回滚：Copy-Item '$backup' '$SettingsPath' -Force"
