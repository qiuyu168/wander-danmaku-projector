# ============================================================
#  元火弹幕姬 · 一键部署启动脚本 (Windows + Docker Desktop)
#
#  功能: 自动检查 Docker -> 生成配置 -> 构建并启动 NapCat + 弹幕服务
#        -> 引导扫码登录 QQ -> 打开弹幕显示页
#
#  使用: 双击 start.bat, 或在本目录执行:
#        powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "[步骤] $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg)  { Write-Host "[OK] $msg" -ForegroundColor Green }

function Write-Err([string]$msg) {
    Write-Host "[错误] $msg" -ForegroundColor Red
    Write-Host ""
    exit 1
}

# ---------- 1. 检查 Docker ----------
Write-Step "检查 Docker 环境"

# 兜底: 若当前终端 PATH 尚未刷新, 主动补入 Docker 安装目录
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    $dockerBin = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'
    if (Test-Path (Join-Path $dockerBin 'docker.exe')) {
        $env:Path = "$dockerBin;$env:Path"
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "未检测到 docker 命令, 请先安装 Docker Desktop:" -ForegroundColor Red
    Write-Host "  https://www.docker.com/products/docker-desktop/" -ForegroundColor Yellow
    exit 1
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker 已安装但尚未运行, 正在尝试启动 Docker Desktop..." -ForegroundColor Yellow
    $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $exe) { Start-Process $exe }
    Write-Host "请等待右下角鲸鱼图标变绿..." -ForegroundColor Yellow
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 4
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { break }
    }
    docker info *> $null
    if ($LASTEXITCODE -ne 0) { Write-Err "等待 Docker 启动超时, 请手动打开 Docker Desktop 后重试" }
}
Write-Ok "Docker 运行正常"

# 确认 docker compose 可用 (Docker Desktop 自带 compose v2)
docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Err "未找到 docker compose, 请升级 Docker Desktop"
}

# ---------- 2. 读取局域网 IP ----------
function Get-LanIP {
    $ip = $null
    try {
        $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
              Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
              Sort-Object InterfaceMetric | Select-Object -First 1 -ExpandProperty IPAddress
    } catch {}
    if (-not $ip) {
        $m = ipconfig | Select-String 'IPv4' | Select-Object -First 1
        if ($m) { $ip = ($m.ToString() -split ':')[-1].Trim() }
    }
    if (-not $ip) { $ip = 'localhost' }
    return $ip
}

# ---------- 3. 收集配置 ----------
Write-Step "配置 QQ 机器人账号与目标群号"

$defaultAccount = ''
if (Test-Path '.env') {
    $m = Select-String -Path '.env' -Pattern '^ACCOUNT=' | Select-Object -First 1
    if ($m) { $defaultAccount = ($m.Line -replace '^ACCOUNT=', '').Trim() }
}

$prompt = '请输入用于扫码登录的 QQ 号(机器人账号)'
if ($defaultAccount) { $prompt += " [默认: $defaultAccount]" }
$account = Read-Host $prompt
if (-not $account) { $account = $defaultAccount }
if (-not $account) { Write-Err "必须提供 QQ 号" }

$defaultGroup = ''
$stateFile = 'napcat\.deploy.json'
if (Test-Path $stateFile) {
    try {
        $st = Get-Content $stateFile -Raw | ConvertFrom-Json
        $defaultGroup = $st.group
    } catch {}
}

$prompt = '请输入要采集弹幕的 QQ 群号'
if ($defaultGroup) { $prompt += " [默认: $defaultGroup]" }
$group = Read-Host $prompt
if (-not $group) { $group = $defaultGroup }
if (-not $group) { Write-Err "必须提供 QQ 群号" }

# ---------- 4. 生成配置文件 ----------
Write-Step "生成配置文件 (.env / docker-compose.yml / NapCat 配置)"

$NoBom = New-Object System.Text.UTF8Encoding $false

$envContent = @"
ACCOUNT=$account
RUST_LOG=info
DANMAKU_LISTEN=0.0.0.0
DANMAKU_PORT=5098
DANMAKU_PRIVATE_PORT=5099
DANMAKU_DEDUP_WINDOW=-1
"@
[System.IO.File]::WriteAllText((Join-Path $Root '.env'), $envContent, $NoBom)
Write-Ok "已生成 .env"

$composeContent = @'
name: danmaku-server
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: danmaku-napcat
    environment:
      - ACCOUNT=${ACCOUNT}
      - NAPCAT_UID=1000
      - NAPCAT_GID=1000
    volumes:
      - ./napcat/config:/app/napcat/config
      - ./napcat/data:/app/.config/QQ
      - ./napcat/logs:/app/napcat/logs
    restart: always
    mem_limit: 1g
    depends_on:
      - danmaku-server

  danmaku-server:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: danmaku-server
    env_file:
      - .env
    ports:
      - "5098:5098"
    restart: always
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'docker-compose.yml'), $composeContent, $NoBom)
Write-Ok "已生成 docker-compose.yml"

New-Item -ItemType Directory -Force -Path 'napcat\config' | Out-Null
$napcatCfg = "napcat\config\onebot11_$account.json"
if (-not (Test-Path $napcatCfg)) {
    Copy-Item 'onebot.template.json' $napcatCfg -Force
    Write-Ok "已生成 NapCat 配置: $napcatCfg"
} else {
    Write-Ok "NapCat 配置已存在, 保留: $napcatCfg"
}

[System.IO.File]::WriteAllText((Join-Path $Root $stateFile), (@{ group = $group } | ConvertTo-Json), $NoBom)

# ---------- 5. 构建并启动 ----------
Write-Step "拉取镜像并构建弹幕服务 (首次构建 Rust 与前端可能需要数分钟, 请耐心等待)"
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Write-Err "docker compose up 失败, 请查看上方错误信息" }
Write-Ok "服务已启动"

# ---------- 6. 引导扫码登录 ----------
$lanIP = Get-LanIP
$viewUrl = "http://${lanIP}:5098/$group"

Write-Step "QQ 扫码登录 (失败自动重新出二维码, 最多 5 次)"

$maxAttempts = 5
$success = $false

# 先重建 NapCat 实例, 清掉可能残留的登录状态, 生成首个二维码
docker compose up -d --force-recreate napcat | Out-Null
Start-Sleep -Seconds 6

for ($attempt = 1; $attempt -le $maxAttempts -and -not $success; $attempt++) {
    Write-Host ""
    Write-Host "=== 第 $attempt/$maxAttempts 次登录 ===" -ForegroundColor Cyan

    if ($attempt -gt 1) {
        Write-Host "[提示] 检测到登录失败, 正在重新生成二维码..." -ForegroundColor Yellow
        docker compose up -d --force-recreate napcat | Out-Null
        Start-Sleep -Seconds 8
    }

    Write-Host "请在刚弹出的 NapCat 日志窗口用 QQ 手机扫码 (暂无二维码请稍等)..." -ForegroundColor Yellow
    Start-Process powershell -WorkingDirectory $Root -ArgumentList @('-NoExit', '-Command', 'docker compose logs -f napcat')

    $deadline = (Get-Date).AddMinutes(4)
    while ((Get-Date) -lt $deadline) {
        $nap = docker compose logs napcat --tail 80 2>&1 | Out-String
        if ($nap -match 'Login Error') { break }

        $srv = docker compose logs danmaku-server --tail 40 2>&1 | Out-String
        if ($srv -match 'connection from' -or $nap -match '登录成功') { $success = $true; break }

        Start-Sleep -Seconds 3
    }
}

if (-not $success) {
    Write-Host ""
    Write-Host "[提示] 连续 $maxAttempts 次登录均失败, 请检查账号风控/登录保护后重新运行本脚本。" -ForegroundColor Red
    exit 1
}
Write-Ok "QQ 登录成功, 弹幕采集链路已建立"

# ---------- 7. 打开弹幕 ----------
Write-Step "打开弹幕显示页并查看采集日志"
Write-Host ""
Write-Host "  弹幕显示页(本机):   http://localhost:5098/$group" -ForegroundColor Green
Write-Host "  弹幕显示页(局域网): $viewUrl" -ForegroundColor Green
Write-Host ""
Write-Host "  其他设备(手机/电脑)连接同一网络后, 用「局域网」地址即可看到弹幕流。" -ForegroundColor Yellow

Start-Process $viewUrl
Start-Process powershell -WorkingDirectory $Root -ArgumentList @('-NoExit', '-Command', 'docker compose logs -f danmaku-server')

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  部署完成! 弹幕采集已开始运行" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  常用命令:" -ForegroundColor White
Write-Host "    查看弹幕日志: docker compose logs -f danmaku-server" -ForegroundColor White
Write-Host "    停止服务:     docker compose down" -ForegroundColor White
Write-Host "    重启服务:     docker compose up -d" -ForegroundColor White
Write-Host "============================================" -ForegroundColor Cyan
