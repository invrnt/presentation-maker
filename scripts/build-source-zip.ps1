$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $Root "apps\local"
$Output = Join-Path $Root "source.zip"
$Temp = Join-Path $env:TEMP ("PresentationMakerSource-" + [Guid]::NewGuid().ToString("N"))

try {
    New-Item -ItemType Directory -Force -Path $Temp | Out-Null
    Copy-Item (Join-Path $Source "*.go") $Temp
    Copy-Item (Join-Path $Source "go.mod") $Temp
    Copy-Item (Join-Path $Source "go.sum") $Temp
    Copy-Item (Join-Path $Source "template.pptx") $Temp
    Copy-Item (Join-Path $Source "web") $Temp -Recurse
    if (Test-Path $Output) { Remove-Item $Output -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($Temp, $Output, [IO.Compression.CompressionLevel]::Optimal, $false)
    $Hash = (Get-FileHash $Output -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -Path ($Output + ".sha256") -Value ($Hash + "  source.zip") -Encoding Ascii
    Write-Host "Creado source.zip"
    Write-Host "SHA-256: $Hash"
} finally {
    if (Test-Path $Temp) { Remove-Item $Temp -Recurse -Force }
}
