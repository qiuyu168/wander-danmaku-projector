param([switch]$CheckOnly, [switch]$EnableWsl)
$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $PSScriptRoot
$serviceDir = Join-Path $bundleRoot 'resources\server'
$logFile = Join-Path $env:TEMP ('wander-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID + '.log')

function Assert-SignedInstaller([string]$File, [string]$Publisher) {
    $sig = Get-AuthenticodeSignature -LiteralPath $File
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch $Publisher) { throw ('安装文件的官方签名校验失败：' + $File) }
    $manifestPath = Join-Path $bundleRoot 'installers\sha256.json'
    if (Test-Path -LiteralPath $manifestPath) {
        $hashes = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $expected = $hashes.([IO.Path]::GetFileName($File))
        if (-not $expected -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $expected) { throw '安装包校验和不匹配，请重新复制完整安装包。' }
    }
}
function Find-Docker {
    $candidates = @('docker.exe', (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'))
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe' }
    $entry = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop' -ErrorAction SilentlyContinue
    if ($entry.InstallLocation) { $candidates += Join-Path $entry.InstallLocation 'resources\bin\docker.exe' }
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    return $null
}
function Run-Native([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('命令执行失败，退出码 ' + $LASTEXITCODE + '：' + $Executable + ' ' + ($Arguments -join ' ')) }
}

try {
    Start-Transcript -Path $logFile | Out-Null
    if ($EnableWsl) {
        $restart = $false
        foreach ($featureName in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')) {
            $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
            if ($feature.State -ne 'Enabled') {
                $result = Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart
                if ($result.RestartNeeded) { $restart = $true }
            }
        }
        if ($restart) { exit 3010 }
        exit 0
    }
    Write-Host 'wander 首次安装：检查环境 → 准备 WSL → 安装 Docker → 准备后台 → 打开客户端' -ForegroundColor Green
    Write-Host '需要联网，部分操作会弹出管理员授权或 Docker 首次使用界面。不会自动重启电脑。'
    $os = Get-CimInstance Win32_OperatingSystem
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw '此便携包适用于 Windows x64，不适用于 32 位或 ARM64 系统。' }
    if ([int]$os.BuildNumber -lt 19045) { throw '请先更新 Windows。此安装器最低检查为 Windows 10 22H2，Docker 当前版本可能要求更新的系统。' }
    foreach ($file in @('electron.exe','resources\app\dist\main.cjs','resources\server\docker-compose.yml','resources\server\Dockerfile')) {
        if (-not (Test-Path -LiteralPath (Join-Path $bundleRoot $file))) { throw ('便携包不完整，缺少：' + $file + '。请完整解压整个 wander 文件夹。') }
    }
    $docker = Find-Docker
    Write-Host ('系统：' + $os.Caption + '，Build ' + $os.BuildNumber)
    Write-Host ('Docker CLI：' + $(if ($docker) { $docker } else { '未安装' }))
    if ($CheckOnly) {
        if ($docker) { & $docker --version; & $docker compose version }
        Write-Host '只读检查完成：没有安装软件、启用组件、启动服务或下载镜像。'
        exit 0
    }
    $probe = Join-Path $bundleRoot ('.install-write-test-' + [guid]::NewGuid().ToString('N'))
    try { [IO.File]::WriteAllText($probe, 'test'); Remove-Item -LiteralPath $probe } catch { throw '目录不可写，请将 wander 解压到例如 D:\wander 的普通可写目录。' }

    # An existing working Linux engine already satisfies the WSL/backend requirement.
    $engineReady = $false
    if ($docker) {
        $ErrorActionPreference = 'Continue'
        $engineType = & $docker info --format '{{.OSType}}' 2>$null
        $ErrorActionPreference = 'Stop'
        $engineReady = $LASTEXITCODE -eq 0 -and $engineType -eq 'linux'
    }
    if (-not $engineReady) {
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        if (-not $cpu.VirtualizationFirmwareEnabled -and -not (Get-CimInstance Win32_ComputerSystem).HypervisorPresent) {
            throw '未检测到已启用的硬件虚拟化。请在 BIOS/UEFI 中开启 Intel VT-x 或 AMD-V/SVM，重启后再运行本脚本。'
        }
        Write-Host '检查并启用 WSL / 虚拟机平台，接下来可能弹出管理员授权。'
        $featureProcess = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -EnableWsl')
        if ($featureProcess.ExitCode -eq 3010) {
            Write-Host '系统组件已启用。请保存工作并重启电脑，然后再次双击“首次安装.bat”继续。' -ForegroundColor Yellow
            exit 3010
        }
        if ($featureProcess.ExitCode -ne 0) { throw '启用 WSL 失败或管理员授权被取消，请检查日志后重试。' }
        $wslInstaller = Join-Path $bundleRoot 'installers\wsl.x64.msi'
        if (Test-Path -LiteralPath $wslInstaller) {
            Assert-SignedInstaller $wslInstaller 'Microsoft'
            $installed = Start-Process msiexec.exe -Verb RunAs -Wait -PassThru -ArgumentList ('/i "' + $wslInstaller + '" /passive /norestart')
            if ($installed.ExitCode -eq 3010) { Write-Host 'WSL 安装完成，请重启后再运行首次安装。'; exit 3010 }
            if ($installed.ExitCode -ne 0) { throw 'WSL 安装未完成，请查看安装界面提示。' }
        } else {
            & wsl.exe --status
            if ($LASTEXITCODE -ne 0) { throw '请保留随包 installers\wsl.x64.msi 后重试；本版不默认从境外下载 WSL。' }
        }
        Run-Native 'wsl.exe' @('--set-default-version','2')
    }
    if (-not $docker) {
        $dockerInstaller = Join-Path $bundleRoot 'installers\Docker Desktop Installer.exe'
        if (-not (Test-Path -LiteralPath $dockerInstaller)) { throw '请复制完整安装包，包含 installers\Docker Desktop Installer.exe。本版优先使用随包官方签名安装程序。' }
        Assert-SignedInstaller $dockerInstaller 'Docker'
        Write-Host '正在使用随包 Docker 官方安装程序，安装会申请管理员权限。'
        $install = Start-Process -FilePath $dockerInstaller -Verb RunAs -Wait -PassThru -ArgumentList 'install --accept-license --backend=wsl-2'
        if ($install.ExitCode -eq 3010 -or $install.ExitCode -eq 1641) { Write-Host 'Docker 安装完成，请重启后再运行首次安装。'; exit 3010 }
        if ($install.ExitCode -ne 0) { throw ('Docker 安装失败，退出码：' + $install.ExitCode) }
        $docker = Find-Docker
        if (-not $docker) { throw '安装结束但未找到 Docker，请按提示重启后重试。' }
    }
    if (-not $engineReady) {
        $desktopCandidates = @((Join-Path (Split-Path -Parent (Split-Path -Parent $docker)) 'Docker Desktop.exe'), (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'))
        $desktopExe = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($desktopExe) { Start-Process -FilePath $desktopExe -WindowStyle Hidden }
        Write-Host '请完成 Docker Desktop 首次界面的协议/设置，使用 Linux containers。等待引擎就绪，最多约 5 分钟……'
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            $ErrorActionPreference = 'Continue'
        $engineType = & $docker info --format '{{.OSType}}' 2>$null
        $ErrorActionPreference = 'Stop'
            if ($LASTEXITCODE -eq 0 -and $engineType -eq 'linux') { $engineReady = $true; break }
            if ($attempt % 6 -eq 0) { Write-Host '仍在等待 Docker；如提示重启，请重启后再次运行此脚本。' }
            Start-Sleep -Seconds 5
        }
        if (-not $engineReady) { throw 'Docker Linux 引擎尚未就绪，请检查 Docker 界面、WSL 和重启提示，然后再运行本脚本。' }
    }
    Run-Native $docker @('compose','version')
    Push-Location -LiteralPath $serviceDir
    try {
        # Never start the QQ containers before the user supplies an account.
        # No existing .env, QQ state or client preferences are overwritten here.
        if (-not (Test-Path -LiteralPath '.env')) { [IO.File]::WriteAllText((Join-Path $serviceDir '.env'), "ACCOUNT=`nRUST_LOG=info`nDANMAKU_DEDUP_WINDOW=-1`n") }
        $archive = Join-Path $bundleRoot 'wander-server-0.3.0.tar'
        if (-not (Test-Path -LiteralPath $archive)) { $archive = Join-Path $bundleRoot 'wander-images.tar' }
        if (Test-Path -LiteralPath $archive) {
            Write-Host '发现随包 Docker 镜像，正在导入。'
            Run-Native $docker @('load','-i',$archive)
        }
        $ErrorActionPreference = 'Continue'
        & $docker image inspect 'wander-server:0.3.0' *> $null
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) {
            Write-Host '首次构建弹幕后台，下载和编译可能较久；详细进度如下。'
            Run-Native $docker @('compose','build','danmaku-server')
        } else { Write-Host '已发现本项目后台镜像，跳过重复构建；升级时可在客户端点击“构建 / 更新服务”。' }
        $ErrorActionPreference = 'Continue'
        & $docker image inspect 'mlikiowa/napcat-docker:latest' *> $null
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) {
            Run-Native $docker @('pull','docker.m.daocloud.io/mlikiowa/napcat-docker:latest')
            Run-Native $docker @('tag','docker.m.daocloud.io/mlikiowa/napcat-docker:latest','mlikiowa/napcat-docker:latest')
        }
    } finally { Pop-Location }
    Write-Host '环境准备完成！接下来填写 QQ 和群号 → 启动 / 连接服务 → 手机扫码 → 选择屏幕 → 开始投屏。' -ForegroundColor Green
    Write-Host '无需为了本程序再重启；只有系统或 Docker 明确要求时才需要重启。'
    $env:ELECTRON_RUN_AS_NODE = $null
    Start-Process -FilePath (Join-Path $bundleRoot 'electron.exe') -WorkingDirectory $bundleRoot
} catch {
    Write-Host ('安装未完成：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ('日志：' + $logFile)
    Write-Host '处理提示的问题后，再次双击“首次安装.bat”即可重试。不会删除已有账号与设置。'
    exit 1
} finally { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null }
