# ollabatch installer for Windows, served by the host:
#   irm __HOST__/install.ps1 | iex
# Unpacks the host's copy of ollabatch into %LOCALAPPDATA%\ollabatch\app, puts
# `ollabatch` on your PATH, starts the agent at login, and opens its page.
# No admin rights needed. Kept ASCII-only for Windows PowerShell 5.1.
& {
  $ErrorActionPreference = 'Stop'
  $hostUrl = '__HOST__'
  $node = Get-Command node -ErrorAction SilentlyContinue
  $major = 0
  if ($node) { $major = [int](& node -p "process.versions.node.split('.')[0]") }
  if ($major -lt 20) {
    Write-Host 'ollabatch needs Node.js 20 or newer. Install it, open a new PowerShell, and run this again:' -ForegroundColor Yellow
    Write-Host '  winget install OpenJS.NodeJS.LTS'
    return
  }
  $app = Join-Path $env:LOCALAPPDATA 'ollabatch\app'
  New-Item -ItemType Directory -Force -Path $app | Out-Null
  $tar = Join-Path $env:TEMP 'ollabatch.tar'
  Write-Host "Downloading ollabatch from $hostUrl ..."
  Invoke-WebRequest "$hostUrl/ollabatch.tar" -OutFile $tar -UseBasicParsing
  # Windows' own tar: a Git or MSYS tar earlier on PATH can't read C:\ paths.
  $winTar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path $winTar)) { $winTar = 'tar' }
  & $winTar -xf $tar -C $app
  Remove-Item $tar
  & node (Join-Path $app 'bin\ollabatch.mjs') install __INSTALL_ARGS__
  Write-Host 'Done. ollabatch runs at login; its page opens now so you can lend this PC.' -ForegroundColor Green
  for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest 'http://127.0.0.1:11510/status' -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 }
  }
  Start-Process "http://127.0.0.1:11510/#join=$hostUrl"
}
