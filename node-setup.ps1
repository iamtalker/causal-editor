# Downloads the official portable Node.js (node.exe only) into <root>\node when Node.js is not installed.
# Called by the .bat file. Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
#
# Safety: the zip is checked against a pinned SHA-256 (the value published in
# https://nodejs.org/dist/<version>/SHASUMS256.txt) before anything is extracted. To update Node.js,
# change $ver and $sha256 together.
param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes Windows PowerShell 5.1 downloads very slow

$ver    = 'v24.14.1'
$sha256 = '6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70'
$url    = "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip"
$dest   = Join-Path ([IO.Path]::GetFullPath($Root)) 'node'
$zip    = Join-Path ([IO.Path]::GetTempPath()) "node-$ver-win-x64.zip"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

    $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $sha256) { throw "Checksum mismatch. expected=$sha256 actual=$actual" }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        foreach ($name in 'node.exe', 'LICENSE') {
            $entry = $archive.Entries | Where-Object { $_.FullName -eq "node-$ver-win-x64/$name" } | Select-Object -First 1
            if (-not $entry) { throw "$name was not found in the archive" }
            # write to a temporary name first so an interrupted run never leaves a half-written node.exe behind
            $tmp = Join-Path $dest "$name.part"
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $tmp, $true)
            Move-Item -Path $tmp -Destination (Join-Path $dest $name) -Force
        }
    } finally { $archive.Dispose() }

    $reported = (& (Join-Path $dest 'node.exe') --version)
    if ($reported -ne $ver) { throw "Unexpected node.exe version: $reported" }
    Write-Host "Node.js $reported is ready in $dest"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    if (Test-Path (Join-Path $dest 'node.exe.part')) { Remove-Item (Join-Path $dest 'node.exe.part') -Force -ErrorAction SilentlyContinue }
    exit 1
} finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
}
