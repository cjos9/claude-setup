#!/usr/bin/env bash
# Installs claude-setup into ~/.claude on macOS and Linux. Arguments go to scripts/install.mjs:
#   --profile <dir>   use this profile (stored for later runs)
#   --pull            copy changes made in Claude Code back into the profile
#   --no-plugins      skip the plugin steps
set -euo pipefail
command -v node >/dev/null 2>&1 || { echo "Missing prerequisite: 'node' is not on PATH." >&2; exit 1; }
exec node "$(cd "$(dirname "$0")" && pwd)/scripts/install.mjs" "$@"
