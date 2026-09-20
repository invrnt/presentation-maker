param(
    [string]$SourceUrl = "https://raw.githubusercontent.com/invrnt/presentation-maker/0da5a3a8244f3e0c9eda67763b83bb41ad6cbff5/source.zip",
    [string]$SourceSha256 = "1839b30176401e27b64f70163cb3db16e3fa2ad1c72734311f6c7436f87febc4",
    [string]$ApiUrl = "https://presentation-maker-api.juan-c.workers.dev"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$InstallDir = Join-Path $env:LOCALAPPDATA "PresentationMaker"
$WorkDir = Join-Path $env:TEMP ("PresentationMakerInstaller-" + [Guid]::NewGuid().ToString("N"))
$GoUrl = "https://go.dev/dl/go1.20.14.windows-amd64.zip"
$GoHash = "0e0d0190406ead891d94ecf00f961bb5cfa15ddd47499d2649f12eee80aee110"
$FfmpegUrl = "https://github.com/GyanD/codexffmpeg/releases/download/7.0.1/ffmpeg-7.0.1-essentials_build.zip"
$FfmpegHash = "39126817bc9ddad04515cd69e22398d1844ea4a0eed01d909e0ae364dec2988c"

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = New-Object Security.Cryptography.SHA256Managed
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally { $stream.Dispose() }
}

function Download-Checked([string]$Url, [string]$Path, [string]$ExpectedHash) {
    $client = New-Object Net.WebClient
    try { $client.DownloadFile($Url, $Path) } finally { $client.Dispose() }
    $actual = Get-Sha256 $Path
    if ($actual -ne $ExpectedHash.ToLowerInvariant()) { throw "La verificación SHA-256 falló para $Url" }
}

function Expand-Zip([string]$Zip, [string]$Destination) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
}

if (-not [Environment]::Is64BitOperatingSystem) { throw "Presentation Maker requiere Windows de 64 bits." }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

try {
    Write-Host "[1/5] Descargando herramientas de compilación"
    $GoZip = Join-Path $WorkDir "go.zip"
    Download-Checked $GoUrl $GoZip $GoHash
    Expand-Zip $GoZip (Join-Path $WorkDir "toolchain")

    Write-Host "[2/5] Compilando la aplicación"
    $SourceZip = Join-Path $WorkDir "source.zip"
    $SourceDir = Join-Path $WorkDir "source"
    Download-Checked $SourceUrl $SourceZip $SourceSha256
    Expand-Zip $SourceZip $SourceDir
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $GoExe = Join-Path $WorkDir "toolchain\go\bin\go.exe"
    $Previous = Get-Location
    Set-Location $SourceDir
    try {
        $env:CGO_ENABLED = "0"
        $env:GOOS = "windows"
        $env:GOARCH = "amd64"
        & $GoExe build -trimpath -ldflags "-s -w -H windowsgui -X main.workerURL=$ApiUrl -X main.version=1.0.0" -o (Join-Path $InstallDir "PresentationMaker.exe") .
        if ($LASTEXITCODE -ne 0) { throw "Go no pudo compilar la aplicación." }
    } finally { Set-Location $Previous }

    Write-Host "[3/5] Instalando herramientas de video"
    $BinDir = Join-Path $InstallDir "bin"
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $FfmpegZip = Join-Path $WorkDir "ffmpeg.zip"
    $FfmpegDir = Join-Path $WorkDir "ffmpeg"
    Download-Checked $FfmpegUrl $FfmpegZip $FfmpegHash
    Expand-Zip $FfmpegZip $FfmpegDir
    $FfmpegExe = Get-ChildItem $FfmpegDir -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
    $FfprobeExe = Get-ChildItem $FfmpegDir -Filter "ffprobe.exe" -Recurse | Select-Object -First 1
    if (-not $FfmpegExe -or -not $FfprobeExe) { throw "El paquete de FFmpeg no contiene los ejecutables esperados." }
    Copy-Item $FfmpegExe.FullName (Join-Path $BinDir "ffmpeg.exe") -Force
    Copy-Item $FfprobeExe.FullName (Join-Path $BinDir "ffprobe.exe") -Force

    $WindowsVersion = [Environment]::OSVersion.Version
    if ($WindowsVersion.Major -eq 6 -and $WindowsVersion.Minor -eq 1) {
        $YtUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/2024.10.22/yt-dlp_x86.exe"
        $YtHash = "ba63c0a53d1f50d1ee1e2e5e87839c5a1321cbeaaf4196003b7aee46c591b364"
        Write-Warning "Windows 7 usa la última versión oficial compatible de yt-dlp. YouTube puede dejar de admitirla."
    } else {
        $YtUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/2025.11.12/yt-dlp.exe"
        $YtHash = "9f8b03a37125854895a7eebf50a605e34e7ec3bd2444931eff377f3ccec50e96"
    }
    Download-Checked $YtUrl (Join-Path $BinDir "yt-dlp.exe") $YtHash

    Write-Host "[4/5] Creando acceso directo"
    $Desktop = [Environment]::GetFolderPath("Desktop")
    $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $Desktop "Presentation Maker.lnk"))
    $Shortcut.TargetPath = Join-Path $InstallDir "PresentationMaker.exe"
    $Shortcut.WorkingDirectory = $InstallDir
    $Shortcut.Description = "Presentation Maker"
    $Shortcut.Save()

    Write-Host "[5/5] Listo"
    Start-Process (Join-Path $InstallDir "PresentationMaker.exe")
} finally {
    if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
}
