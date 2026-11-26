$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $PSScriptRoot 'danmaku-server-master\danmaku-server-master'
$dockerRoot = 'D:\DanmakuRuntime\Docker'
$dockerBin = Join-Path $dockerRoot 'resources\bin'
if (Test-Path $dockerBin) { $env:Path = "$dockerBin;$env:Path" }
if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    throw 'Docker is not installed yet. Check D:\DanmakuRuntime\logs\install-runtime.log.'
}
Set-Location -LiteralPath $projectRoot
function Test-DockerReady {
    try {
        docker.exe info *> $null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}
if (-not (Test-DockerReady)) {
    Write-Host 'Starting Docker Desktop. Complete any first-launch prompts in Docker Desktop.'
    Start-Process -FilePath (Join-Path $dockerRoot 'Docker Desktop.exe') -WindowStyle Hidden
    $ready = $false
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        Start-Sleep -Seconds 3
        if (Test-DockerReady) { $ready = $true; break }
    }
    if (-not $ready) { throw 'Docker engine is not ready. Restart Windows first, then check Docker Desktop.' }
}
if (-not (Test-Path '.env')) {
    & (Join-Path $projectRoot 'start.ps1')
    exit
}
Write-Host 'Building and starting the existing project configuration. The first build may take several minutes.'
docker.exe compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Project startup failed. See the command output above.' }
docker.exe compose ps
$group = $null
if (Test-Path 'napcat\.deploy.json') {
    $group = (Get-Content 'napcat\.deploy.json' -Raw | ConvertFrom-Json).group
}
if ($group) { Start-Process "http://localhost:5098/$group" }
Write-Host 'If no QQ messages appear, read the NapCat logs below and scan the login QR code when requested.'
Write-Host 'Press Ctrl+C to stop following logs. Containers will keep running.'
docker.exe compose logs -f napcat danmaku-server
