# ============================================================
#  元火弹幕姬 · 环境初始化脚本 (Windows + Docker Desktop)
#
#  作用: 检查 Docker -> 配置 Docker Hub 镜像加速 -> 重启生效
#  用途: 给第一次部署弹幕姬的人用, 运行一次即可
#  使用: 双击 安装环境.bat
# ============================================================

$ErrorActionPreference = 'Stop'

$dockerExe  = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
$desktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
$daemonPath = Join-Path $env:USERPROFILE '.docker\daemon.json'

function Write-Step([string]$m) { Write-Host ""; Write-Host "[步骤] $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)  { Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Err([string]$m){ Write-Host "[错误] $m" -ForegroundColor Red; Write-Host ""; exit 1 }

function Test-DockerEngine {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    if (Test-Path $dockerExe) {
        & $dockerExe info *> $null
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    return $false
}

# ---------- 1. 检查 Docker Desktop ----------
Write-Step "检查 Docker Desktop"
if (-not (Test-Path $desktopExe)) {
    Write-Host "未检测到 Docker Desktop, 正在打开官方下载页..." -ForegroundColor Yellow
    Start-Process 'https://www.docker.com/products/docker-desktop/'
    Write-Err "请先安装 Docker Desktop (若提示重启请重启), 再重新运行本脚本"
}
Write-Ok "已安装 Docker Desktop"

# ---------- 2. 确保引擎运行 ----------
Write-Step "启动 Docker 引擎 (若未运行)"
if (-not (Test-DockerEngine)) {
    Write-Host "Docker 引擎未运行, 正在启动 Docker Desktop..." -ForegroundColor Yellow
    if (Test-Path $desktopExe) { Start-Process $desktopExe }
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 4
        if (Test-DockerEngine) { $ok = $true; break }
    }
    if (-not $ok) { Write-Err "等待 Docker 启动超时, 请手动打开 Docker Desktop 后重试" }
}
Write-Ok "Docker 引擎运行正常"

# ---------- 3. 写入镜像加速配置 (保留已有配置) ----------
Write-Step "配置 Docker Hub 镜像加速"
New-Item -ItemType Directory -Force -Path (Split-Path $daemonPath) | Out-Null

$mirrors = @(
    'https://docker.m.daocloud.io',
    'https://docker.1ms.run',
    'https://hub.rat.dev'
)

$obj = $null
if (Test-Path $daemonPath) {
    $raw = Get-Content $daemonPath -Raw
    if ($raw -and $raw.Trim()) {
        try { $obj = $raw | ConvertFrom-Json } catch { $obj = $null }
    }
}
if (-not $obj) { $obj = [pscustomobject]@{} }

$obj | Add-Member -MemberType NoteProperty -Name 'registry-mirrors' -Value $mirrors -Force

[System.IO.File]::WriteAllText($daemonPath, ($obj | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false))
Write-Ok "已写入镜像加速配置"

# ---------- 4. 重启 Docker 使配置生效 ----------
Write-Step "重启 Docker Desktop (使镜像加速生效)"
Get-Process | Where-Object { $_.Name -like 'Docker*' -or $_.Name -like 'com.docker*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 8
Start-Process $desktopExe

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 4
    if (Test-DockerEngine) { $ok = $true; break }
}
if (-not $ok) { Write-Err "Docker 重启后未就绪, 请手动打开 Docker Desktop" }

# ---------- 5. 校验 ----------
Write-Step "校验镜像加速是否生效"
$m = if (Get-Command docker -ErrorAction SilentlyContinue) { docker info --format '{{json .RegistryConfig.Mirrors}}' 2>&1 } else { & $dockerExe info --format '{{json .RegistryConfig.Mirrors}}' 2>&1 }
Write-Host "当前镜像源: $m"
if ("$m" -match 'daocloud|1ms|rat.dev') {
    Write-Ok "镜像加速已生效"
} else {
    Write-Host "[提示] 配置已写入但暂未探测到生效, 可打开 Docker Desktop -> Settings -> Docker Engine 手动确认。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  环境配置完成!" -ForegroundColor Cyan
Write-Host "  下一步: 双击 start.bat 一键部署弹幕姬" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan