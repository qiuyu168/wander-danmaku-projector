param([string]$Target, [switch]$CheckOnly, [switch]$FilesOnly, [switch]$NoLaunch)
$ErrorActionPreference='Stop'
$payload=Join-Path $PSScriptRoot 'payload'
function Native([string]$Exe,[string[]]$Arguments){ & $Exe @Arguments; if($LASTEXITCODE -ne 0){throw ('操作失败：'+$Exe+' '+($Arguments -join ' '))} }
try {
    if(-not $Target){
        Add-Type -AssemblyName System.Windows.Forms
        $picker=New-Object System.Windows.Forms.FolderBrowserDialog
        $picker.Description='选择旧版 wander 文件夹（包含 electron.exe 的目录，不是整个源码工程）'
        if($picker.ShowDialog() -ne 'OK'){exit 0};$Target=$picker.SelectedPath
    }
    $Target=[IO.Path]::GetFullPath($Target)
    if(-not (Test-Path -LiteralPath (Join-Path $Target 'electron.exe'))){throw '所选目录不是 wander 便携目录：缺少 electron.exe。'}
    if(-not (Test-Path -LiteralPath (Join-Path $Target 'resources\server\Cargo.toml'))){throw '所选便携包缺少服务目录，请先恢复完整的旧版目录。'}
    $manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    $versionPath=Join-Path $Target '版本信息.json'
    if(Test-Path -LiteralPath $versionPath){$version=Get-Content -LiteralPath $versionPath -Encoding UTF8 -Raw | ConvertFrom-Json;if($version.electron -and $version.electron -ne $manifest.electron){throw '此升级包适用于 Electron 45.3.1 的 wander 旧版。当前运行时不同，请使用完整便携包；仍可沿用 Docker 和 QQ 数据。'}}
    foreach($entry in $manifest.files){
        $destination=[IO.Path]::GetFullPath((Join-Path $Target $entry.path))
        if(-not $destination.StartsWith($Target.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw '升级清单含越界路径。'}
        if($entry.path -match '(^|[\\/])(napcat|\.env|settings\.json|join-cards)([\\/]|$)'){throw '升级包不应覆盖用户数据。'}
        if((Get-FileHash -LiteralPath (Join-Path $payload $entry.path) -Algorithm SHA256).Hash -ne $entry.sha256){throw ('升级文件校验失败：'+$entry.path)}
    }
    if($CheckOnly){Write-Host ('检查通过：'+$manifest.version+'，'+$manifest.files.Count+' 个文件；未写入旧目录或启动服务。');exit 0}
    $running=Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object {$_.ExecutablePath -eq (Join-Path $Target 'electron.exe')}
    if($running){throw '请先在旧客户端系统托盘选择“退出客户端（保留服务）”，再重新运行升级。关闭面板不等于退出。'}
    $backup=Join-Path $Target ('upgrade-backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    foreach($entry in $manifest.files){
        $dest=Join-Path $Target $entry.path
        if(Test-Path -LiteralPath $dest){$old=Join-Path $backup $entry.path;New-Item -ItemType Directory -Path (Split-Path -Parent $old) -Force | Out-Null;Copy-Item -LiteralPath $dest -Destination $old -Force}
        New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $payload $entry.path) -Destination $dest -Force
    }
    if($FilesOnly){Write-Host ('仅文件升级完成，备份：'+$backup);exit 0}
    $docker=Get-Command docker.exe -ErrorAction SilentlyContinue
    if(-not $docker){$reg=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop' -ErrorAction SilentlyContinue;if($reg.InstallLocation){$docker=Get-Command (Join-Path $reg.InstallLocation 'resources\bin\docker.exe') -ErrorAction SilentlyContinue}}
    if(-not $docker){throw '文件已升级，但未找到 Docker；启动 Docker 后在客户端更新服务。'}
    Native $docker.Source @('info','--format','{{.OSType}}')
    $service=Join-Path $Target 'resources\server'
    # Preserve the actively used backend location, including a development checkout.
    $ErrorActionPreference='Continue'
    $inspect=& $docker.Source inspect danmaku-server 2>$null
    $inspectCode=$LASTEXITCODE;$ErrorActionPreference='Stop'
    if($inspectCode -eq 0){
        $active=($inspect | ConvertFrom-Json)[0].Config.Labels.'com.docker.compose.project.working_dir'
        if($active -and (Test-Path -LiteralPath (Join-Path $active 'Cargo.toml')) -and [IO.Path]::GetFullPath($active) -ne [IO.Path]::GetFullPath($service)){
            # Copy only server program files, never .env or napcat runtime data.
            foreach($entry in $manifest.files | Where-Object {$_.path.StartsWith('resources/server/')} ){
                $relative=$entry.path.Substring('resources/server/'.Length);$dest=Join-Path $active $relative
                if(Test-Path -LiteralPath $dest){$old=Join-Path $backup ('active-server/'+$relative);New-Item -ItemType Directory -Path (Split-Path -Parent $old) -Force | Out-Null;Copy-Item -LiteralPath $dest -Destination $old -Force}
                New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null;Copy-Item -LiteralPath (Join-Path $payload $entry.path) -Destination $dest -Force
            }
            $service=$active
        }
    }
    Native $docker.Source @('load','-i',(Join-Path $Target 'wander-server-0.3.0.tar'))
    $restartQQ=$false
    foreach($configFile in Get-ChildItem -LiteralPath (Join-Path $service 'napcat\config') -Filter 'onebot11_*.json' -ErrorAction SilentlyContinue){
        $config=Get-Content -LiteralPath $configFile.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
        foreach($connection in $config.network.websocketClients){
            if($connection.name -eq 'danmaku' -and (-not $connection.reportSelfMessage -or $connection.heartInterval -ne 15000)){
                Copy-Item -LiteralPath $configFile.FullName -Destination ($configFile.FullName+'.pre-030.bak') -Force
                $connection.reportSelfMessage=$true;$connection.heartInterval=15000;$restartQQ=$true
            }
        }
        if($restartQQ){[IO.File]::WriteAllText($configFile.FullName,($config | ConvertTo-Json -Depth 40),(New-Object Text.UTF8Encoding($false)))}
    }
    Push-Location -LiteralPath $service
    try{
        Native $docker.Source @('compose','up','-d','--no-deps','danmaku-server')
        if($restartQQ){Write-Host '首次启用自身消息上报，需要重启一次 QQ 接入；后续日常启动不重复重启。';Native $docker.Source @('compose','restart','napcat')}
    }finally{Pop-Location}
    Write-Host ('升级完成。依赖、QQ 数据、屏蔽词和二维码均保留。备份：'+$backup) -ForegroundColor Green
    $env:ELECTRON_RUN_AS_NODE=$null;$env:DANMAKU_PROJECT_DIR=$service
    if(-not $NoLaunch){Start-Process -FilePath (Join-Path $Target 'electron.exe') -WorkingDirectory $Target}
}catch{
    Write-Host ('升级未全部完成：'+$_.Exception.Message) -ForegroundColor Red
    Write-Host '已复制的程序文件可保留；启动 Docker 后重跑升级可继续。不要删除旧 QQ 数据或重装依赖。'
    exit 1
}
