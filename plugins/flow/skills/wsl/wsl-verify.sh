#!/usr/bin/env bash
# Usage: wsl-verify.sh <repo path in WSL> <command...>
# Mirrors the repo into ~/verify/<name>-<hash> without build output and .git, then runs the command there.
# Building inside /mnt/c would clash with the Windows build's obj folders.
set -euo pipefail

# Validate source path before rsync
src="${1:-}"
if [[ -z "$src" ]]; then
  echo "wsl-verify.sh: missing <repo path in WSL>" >&2
  exit 2
fi

# Strip trailing slashes for validation
normalized="$src"
while [[ "$normalized" == */ ]]; do
  normalized="${normalized%/}"
done

if [[ ! "$normalized" =~ ^/mnt/ ]]; then
  echo "wsl-verify.sh: repo path must be in /mnt" >&2
  exit 2
fi

if [[ "$normalized" =~ ^/mnt/[a-zA-Z]$ ]]; then
  echo "wsl-verify.sh: cannot mirror a drive root" >&2
  exit 2
fi

# Reject if any path segment is exactly ".."
IFS=/ read -ra parts <<< "$normalized"
for part in "${parts[@]}"; do
  if [[ "$part" == ".." ]]; then
    echo "wsl-verify.sh: path cannot contain .. segments" >&2
    exit 2
  fi
done

if [[ ! "$normalized" =~ ^/mnt/[a-zA-Z]/ ]]; then
  echo "wsl-verify.sh: path must be under /mnt/<drive>/" >&2
  exit 2
fi

shift
if [[ $# -eq 0 ]]; then
  echo "wsl-verify.sh: missing <command...>" >&2
  exit 2
fi

# The path hash keeps same-named repos and worktrees from different places apart.
dest="$HOME/verify/$(basename "$src")-$(printf '%s' "$src" | md5sum | cut -c1-8)"
mkdir -p "$dest"
rsync -a --delete \
  --exclude .git/ --exclude bin/ --exclude obj/ --exclude .venv/ \
  --exclude node_modules/ --exclude artifacts/ --exclude .claude/worktrees/ \
  "$src"/ "$dest"/
cd "$dest"
export PATH="$HOME/.local/bin:$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
echo "flow:wsl -> $dest: $*"
exec "$@"
