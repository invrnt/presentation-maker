param(
    [string]$SourceUrl = "https://github.com/invrnt/presentation-maker/releases/latest/download/source.zip",
    [string]$SourceSha256 = "",
    [string]$SourceSha256Url = "https://github.com/invrnt/presentation-maker/releases/latest/download/source.zip.sha256",
    [string]$ApiUrl = "https://presentation-maker-api.juan-c.workers.dev"
)

$ErrorActionPreference = "Stop"
try {
    # El valor numérico funciona aunque el .NET antiguo de Windows 7 no exponga Tls12 en el enum.
    [Net.ServicePointManager]::SecurityProtocol = [Enum]::ToObject([Net.SecurityProtocolType], 3072)
} catch {
    throw "No se pudo activar TLS 1.2. Instala las actualizaciones pendientes de Windows 7 y vuelve a intentarlo."
}

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
    try {
        $client.DownloadFile($Url, $Path)
    } catch {
        throw "No se pudo descargar $Url. Revisa la fecha y hora del equipo y las actualizaciones de certificados de Windows. Detalle: $($_.Exception.Message)"
    } finally { $client.Dispose() }
    $actual = Get-Sha256 $Path
    if ($actual -ne $ExpectedHash.ToLowerInvariant()) { throw "La verificación SHA-256 falló para $Url" }
}

function Expand-Zip([string]$Zip, [string]$Destination) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
        [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
        return
    } catch {
        Write-Host "Usando el extractor compatible con Windows 7"
    }

    $Shell = New-Object -ComObject Shell.Application
    $ZipFolder = $Shell.NameSpace($Zip)
    $DestinationFolder = $Shell.NameSpace($Destination)
    if (-not $ZipFolder -or -not $DestinationFolder) { throw "Windows no pudo abrir el archivo ZIP." }
    $DestinationFolder.CopyHere($ZipFolder.Items(), 20)

    $PreviousSize = -1
    $StableChecks = 0
    $Deadline = [DateTime]::UtcNow.AddMinutes(10)
    while ($StableChecks -lt 5) {
        if ([DateTime]::UtcNow -gt $Deadline) { throw "La extracción del archivo ZIP tardó demasiado." }
        Start-Sleep -Seconds 1
        $Files = Get-ChildItem $Destination -Recurse -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer }
        $CurrentSize = ($Files | Measure-Object -Property Length -Sum).Sum
        if ($null -eq $CurrentSize) { $CurrentSize = 0 }
        if ($CurrentSize -gt 0 -and $CurrentSize -eq $PreviousSize) { $StableChecks++ } else { $StableChecks = 0 }
        $PreviousSize = $CurrentSize
    }
}

$Is64BitOS = ($env:PROCESSOR_ARCHITECTURE -eq "AMD64") -or ($env:PROCESSOR_ARCHITEW6432 -eq "AMD64")
if (-not $Is64BitOS) { throw "Presentation Maker requiere Windows de 64 bits." }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

try {
    Write-Host "[1/5] Descargando herramientas de compilación"
    $GoZip = Join-Path $WorkDir "go.zip"
    Download-Checked $GoUrl $GoZip $GoHash
    Expand-Zip $GoZip (Join-Path $WorkDir "toolchain")

    Write-Host "[2/5] Compilando la aplicación"
    $SourceZip = Join-Path $WorkDir "source.zip"
    $SourceDir = Join-Path $WorkDir "source"
    if (-not $SourceSha256 -or $SourceSha256.Trim().Length -eq 0) {
        $SourceHashFile = Join-Path $WorkDir "source.zip.sha256"
        $HashClient = New-Object Net.WebClient
        try {
            $HashClient.DownloadFile($SourceSha256Url, $SourceHashFile)
        } catch {
            throw "No se pudo descargar $SourceSha256Url. Revisa la fecha y hora del equipo y las actualizaciones de certificados de Windows. Detalle: $($_.Exception.Message)"
        } finally { $HashClient.Dispose() }
        $SourceSha256 = ((Get-Content $SourceHashFile | Select-Object -First 1) -split '\s+')[0]
        if ($SourceSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "La release no contiene un SHA-256 válido." }
    }
    Download-Checked $SourceUrl $SourceZip $SourceSha256
    Expand-Zip $SourceZip $SourceDir
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $GoExe = Join-Path $WorkDir "toolchain\go\bin\go.exe"
    $Previous = Get-Location
    Set-Location $SourceDir
    try {
        $AppVersion = "1.0.0"
        $VersionFile = Join-Path $SourceDir "VERSION"
        if (Test-Path $VersionFile) { $AppVersion = (Get-Content $VersionFile | Select-Object -First 1).Trim() }
        $env:CGO_ENABLED = "0"
        $env:GOOS = "windows"
        $env:GOARCH = "amd64"
        & $GoExe build -trimpath -ldflags "-s -w -H windowsgui -X main.workerURL=$ApiUrl -X main.version=$AppVersion" -o (Join-Path $InstallDir "PresentationMaker.exe") .
        if ($LASTEXITCODE -ne 0) { throw "Go no pudo compilar la aplicación." }
        & $GoExe build -trimpath -ldflags "-s -w -H windowsgui -X main.version=$AppVersion" -o (Join-Path $InstallDir "PresentationMakerUpdater.exe") .\updater
        if ($LASTEXITCODE -ne 0) { throw "Go no pudo compilar el actualizador." }
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
