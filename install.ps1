<#
.SYNOPSIS
Installs claude-setup into ~/.claude on Windows.

.DESCRIPTION
Checks that node is on PATH and hands every argument to scripts/install.mjs:
  --profile <dir>   use this profile (stored for later runs)
  --pull            copy changes made in Claude Code back into the profile
  --no-plugins      skip the plugin steps
#>
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: 'node' is not on PATH." }
& node (Join-Path $PSScriptRoot 'scripts\install.mjs') @args
exit $LASTEXITCODE
