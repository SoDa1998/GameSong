# Builds native/bin/gs-exclusive.exe (GameSong's WASAPI exclusive-mode FLAC player) with the
# C# compiler that ships with Windows (.NET Framework 4.x) — no SDK needed.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }
$out = Join-Path $root 'native\bin'
New-Item -ItemType Directory -Force $out | Out-Null
$src = Get-ChildItem (Join-Path $root 'native\exclusive') -Filter *.cs | ForEach-Object { $_.FullName }
& $csc /nologo /platform:x64 /optimize+ /warn:4 /target:exe `
    /r:System.dll /r:System.Core.dll /r:System.Web.Extensions.dll `
    "/out:$out\gs-exclusive.exe" $src
if ($LASTEXITCODE -ne 0) { throw 'gs-exclusive build failed' }
Write-Host "Built $out\gs-exclusive.exe"
