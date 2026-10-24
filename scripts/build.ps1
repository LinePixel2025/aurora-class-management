[CmdletBinding()]
param(
  [string]$PluginDir,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptRoot)) { $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ($null -eq $PluginDir -or $PluginDir -eq '') { $PluginDir = Join-Path $scriptRoot '..\class-management' }
if ($null -eq $OutDir -or $OutDir -eq '') { $OutDir = Join-Path $scriptRoot '..\dist' }

$root = (Resolve-Path (Join-Path $scriptRoot '..')).Path
$plugin = (Resolve-Path $PluginDir).Path
$checker = Join-Path $root 'plugin-dev-kit\tools\check-plugin.mjs'
$tests = Join-Path $root 'dev\test-plugin.mjs'
$manifestPath = Join-Path $plugin 'manifest.json'

if (-not (Test-Path $manifestPath)) { throw "找不到清单：$manifestPath" }
if (-not (Test-Path $tests)) { throw "找不到测试脚本：$tests" }

if (Test-Path $checker) {
  Write-Host '== 1/3 清单与 schema 静态校验 ==' -ForegroundColor Cyan
  & node $checker $plugin
  if ($LASTEXITCODE -ne 0) { throw '静态校验未通过' }
} else {
  Write-Host '== 1/3 跳过独立静态校验 ==' -ForegroundColor Yellow
  Write-Host '  未找到 plugin-dev-kit（本仓库不包含）；继续执行宿主 zod 与全链路测试。'
}

Write-Host ''
Write-Host '== 2/3 离线全链路测试 ==' -ForegroundColor Cyan
& node $tests
if ($LASTEXITCODE -ne 0) { throw '测试未通过' }

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path (Resolve-Path $OutDir).Path ("class-management-$($manifest.version).zip")
if (Test-Path $zip) { Remove-Item $zip -Force }

Write-Host ''
Write-Host '== 3/3 打包 ==' -ForegroundColor Cyan

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$includes = @('manifest.json', 'main.js', 'lib', 'ui', 'skills', 'types', 'README.md')
$files = @()
foreach ($item in $includes) {
  $path = Join-Path $plugin $item
  if (-not (Test-Path $path)) { throw "打包缺少：$item" }
  if ((Get-Item $path).PSIsContainer) {
    $files += @(Get-ChildItem -Path $path -Recurse -File)
  } else {
    $files += @(Get-Item $path)
  }
}

$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $files) {
    $entryName = $file.FullName.Substring($plugin.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $archive.Dispose()
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $names = @($archive.Entries | ForEach-Object { $_.FullName })
} finally {
  $archive.Dispose()
}
if ($names -notcontains 'manifest.json') { throw 'zip 根目录缺少 manifest.json' }
if ($names | Where-Object { $_ -like '*node_modules*' }) { throw 'zip 中不应包含 node_modules' }
if ($names | Where-Object { $_ -like '*\*' }) { throw 'zip 条目应使用正斜杠' }

$hash = Get-FileHash $zip -Algorithm SHA256
$sizeKb = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host ''
Write-Host "✓ 插件包：$zip" -ForegroundColor Green
Write-Host "  大小：$sizeKb KB"
Write-Host "  SHA-256：$($hash.Hash)"
Write-Host ''
Write-Host '安装：Aurora → 设置 → 插件 → 已安装 → 安装插件包，选择上面的 zip。' -ForegroundColor Yellow