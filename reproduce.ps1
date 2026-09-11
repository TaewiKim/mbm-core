# Thin PowerShell wrapper around reproduce.mjs.
# Usage: pwsh reproduce.ps1 [--install] [--check-only] [--paper]
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $here "reproduce.mjs") @args
exit $LASTEXITCODE
