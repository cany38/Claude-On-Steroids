# Used by setup.bat when winget is missing or has not caught up yet. Downloads the
# official Node.js installer from nodejs.org, checks its SHA256 and runs it.
# -Version takes a version such as v24.22.1, or lts for the newest LTS release.
param([string]$Version = 'lts')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($Version -eq 'lts') {
  # Windows PowerShell passes a JSON array down the pipeline as one item, so unroll it first.
  $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $Version = ($releases | Where-Object { $_.lts } | Select-Object -First 1).version
}
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "node-$Version-$arch.msi"
$base = "https://nodejs.org/dist/$Version"
$msi = Join-Path $env:TEMP $name

Write-Host "Downloading $name..."
Invoke-WebRequest "$base/$name" -OutFile $msi -UseBasicParsing
$sums = [Text.Encoding]::UTF8.GetString((Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).RawContentStream.ToArray())
$line = $sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($name))\s*$" } | Select-Object -First 1
if (-not $line) { throw "$name is not listed in SHASUMS256.txt" }
$want = ($line -split '\s+')[0].ToUpper()
if ((Get-FileHash $msi -Algorithm SHA256).Hash -ne $want) {
  Remove-Item $msi -Force
  throw "the SHA256 of $name does not match nodejs.org"
}

Write-Host "Installing Node.js $Version. Windows may ask for permission."
$p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/passive', '/norestart' -Wait -PassThru
Remove-Item $msi -Force
if ($p.ExitCode -notin 0, 3010) { throw "the installer stopped with code $($p.ExitCode)" }
