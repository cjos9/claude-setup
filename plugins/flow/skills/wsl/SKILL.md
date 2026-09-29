---
name: wsl
description: Windows only - run commands that need Linux on a Windows machine whose Docker or Python lives in WSL - Docker or Testcontainers integration tests, Python tooling (uv, pytest, ruff, mypy), or .NET tests that Smart App Control blocks with 0x800711C7 or "Zero tests ran". Use whenever such a test or command is needed on Windows.
---

# Running things in WSL

`~/.claude/claude-setup/machine.md` (written by the claude-setup installer) names this machine's WSL distro and what runs in it. If it says Docker and Python run on the host, or the machine is a Mac, you do not need this skill: run the commands directly. If machine.md is missing or names no distro, run the claude-setup installer (`install.ps1`) and restart Claude Code; if it still names none, Docker and Python are not set up in WSL yet.

## .NET tests that need Docker, or that Smart App Control blocks

Run from inside the repository:

```bash
node "${CLAUDE_SKILL_DIR}/wsl-verify.mjs" dotnet test -c Release
```

The script mirrors the repo to `~/verify/<repo>-<hash of its path>` in WSL (without `.git`, `bin`, `obj`) and runs the command there. Never build inside `/mnt/c`: the `obj` folders clash with the Windows build. Without `.git`, MinVer falls back to a default version; that is expected.

## Python projects (uv)

Run from the repository root, with the distro named in machine.md (WSL starts in the current directory):

```bash
wsl -d <distro> --exec bash -lc 'uv run pytest'
```

Use the same pattern for `uv sync`, `uv run ruff check`, `uv run ruff format --check` and `uv run mypy`. In `.claude/flow.json`, write the plain command and `"runIn": "linux"` instead.

## Docker itself

```bash
wsl -d <distro> --exec docker ps
```

If Docker is not running, `sudo systemctl start docker` needs the user's password: ask the user to run it.

## Report

Show the command and the summary lines of its output (passed, failed, skipped) as evidence.
