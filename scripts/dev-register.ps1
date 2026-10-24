[CmdletBinding()]
param(
  [switch]$Remove,
  [string]$PluginDir
)

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptRoot)) { $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ($null -eq $PluginDir -or $PluginDir -eq '') { $PluginDir = Join-Path $scriptRoot '..\class-management' }

$plugin = (Resolve-Path $PluginDir).Path
$manifestPath = Join-Path $plugin 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "找不到插件清单：$manifestPath" }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$running = @(Get-Process -Name Aurora -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  $pids = ($running | Select-Object -ExpandProperty Id) -join ', '
  Write-Host "✗ Aurora 正在运行（PID: $pids）。" -ForegroundColor Red
  Write-Host '  请先完全退出 Aurora，再重新运行本脚本；脚本不会自动结束你的应用。' -ForegroundColor Yellow
  exit 1
}

$configPath = Join-Path $env:APPDATA 'Aurora\config.json'
if (-not (Test-Path $configPath)) {
  Write-Host "✗ 找不到 Aurora 配置：$configPath" -ForegroundColor Red
  Write-Host '  请先启动一次 Aurora 生成配置，再退出后重试。' -ForegroundColor Yellow
  exit 1
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$configPath.bak-$timestamp"
Copy-Item -Path $configPath -Destination $backupPath -Force

try {
  $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $config.plugins) {
    $config | Add-Member -MemberType NoteProperty -Name plugins -Value ([pscustomobject]@{})
  }
  $dirs = @()
  if ($null -ne $config.plugins.devDirs) { $dirs = @($config.plugins.devDirs) }

  $exists = @($dirs | Where-Object { $_ -eq $plugin }).Count -gt 0
  if ($Remove) {
    $dirs = @($dirs | Where-Object { $_ -ne $plugin })
  } elseif (-not $exists) {
    $dirs += $plugin
  }
  $config.plugins | Add-Member -MemberType NoteProperty -Name devDirs -Value @($dirs | Select-Object -Unique) -Force

  $json = $config | ConvertTo-Json -Depth 20
  $tempPath = "$configPath.tmp"
  [System.IO.File]::WriteAllText($tempPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -Path $tempPath -Destination $configPath -Force
} catch {
  Copy-Item -Path $backupPath -Destination $configPath -Force
  throw "写入配置失败，已用备份还原：$($_.Exception.Message)"
}

if ($Remove) {
  Write-Host "✓ 已从开发目录移除：$plugin" -ForegroundColor Green
} else {
  Write-Host "✓ 已注册开发目录：$plugin" -ForegroundColor Green
}
Write-Host "  插件 id：$($manifest.id)"
Write-Host "  配置备份：$backupPath"
if ($null -ne $config.plugins -and $config.plugins.enabled -eq $false) {
  Write-Host '  ! 注意：Aurora 的插件总开关当前是关闭的，请在 设置 → 插件 里打开。' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '下一步：启动 Aurora → 设置 → 插件 → 开发，确认本目录已加载。' -ForegroundColor Yellow
Write-Host '之后修改 main.js / lib/ 会在约 300ms 防抖后自动重启插件。' -ForegroundColor Yellow