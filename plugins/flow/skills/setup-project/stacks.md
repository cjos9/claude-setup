# Stack reference for setup-project

| Signal in the repo | Stack |
| --- | --- |
| `*.slnx`, `*.sln`, `global.json`, `Directory.Build.props` | .NET |
| `pyproject.toml`, `uv.lock` | Python |
| `ansible.cfg`, `*.tf`, `Chart.yaml` | Infrastructure as code |
| `package.json` | Node |

A repository can hold several stacks (for example a .NET API and a Node frontend). Cover each one.

Stacks this file does not cover: take build, test and lint commands from the CI and leave `permissions.allow` empty.

`timeoutSec` must stay below 900: the Stop hook itself is cancelled after 900 s.

`flow.json` is shared by every machine that works on the repo (Windows, macOS, Linux). Write commands that work on all of them: plain commands, plus `"runIn": "linux"` for tools that live in WSL on Windows (Python, Ansible, Docker). With `runIn`, the command runs in the WSL distro named in `~/.claude/claude-setup/machine.json` on Windows and directly on macOS and Linux.

## .NET

- Commands: copy them from the CI. Typical: `dotnet restore`, `dotnet build -c Release --no-restore`, `dotnet test -c Release --no-build`.
- `flow.json`:

  ```json
  {
    "check": "dotnet build -c Release --nologo -v q",
    "checkOn": [".cs", ".csproj", ".props", ".targets", ".slnx", ".sln", ".razor"],
    "test": "dotnet test -c Release --no-build",
    "timeoutSec": 300
  }
  ```

- `permissions.allow`: `Bash(dotnet restore *)`, `Bash(dotnet build *)`, `Bash(dotnet test *)`, `Bash(dotnet format *)`, `Bash(dotnet pack *)`, `Bash(dotnet list *)`.
- Test projects that run only on Microsoft.Testing.Platform (TUnit, or xUnit v3 without `xunit.runner.visualstudio`; MSTest and NUnit runners fall back to VSTest): `dotnet test` finds their tests with the .NET 10 SDK or later only with `"test": { "runner": "Microsoft.Testing.Platform" }` in `global.json`, and with earlier SDKs only with `<TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>`. A repository built with both SDKs needs both.
- Check for these gotchas: central package versions in `Directory.Packages.props`; MinVer or other tag-based versioning; Testcontainers tests that need Docker (on Windows run them with the `wsl` skill); application control (Smart App Control) blocking fresh test DLLs on Windows.

## Python (uv)

- `flow.json`: the CI's lint and type gates, for example:

  ```json
  {
    "check": "uv run ruff check && uv run ruff format --check && uv run mypy src",
    "checkOn": [".py", ".pyi", ".toml"],
    "test": "uv run pytest -q",
    "runIn": "linux",
    "timeoutSec": 300
  }
  ```

- `permissions.allow`: none on Windows, because WSL runs arbitrary code and the auto mode classifier should judge each call; `Bash(uv run *)` is fine on projects nobody works on from Windows.

## Infrastructure as code

- `check`: lint and validate only, as the CI does (for example `ansible-lint`, `terraform validate`, `helm lint`), with `"runIn": "linux"` for tools that live in WSL on Windows. Never apply, deploy or run a playbook against a host in the check.
- CLAUDE.md must name the environments and hosts that are production and state that applying changes, deploying and changing secrets need the user's explicit go.

## Node

- `check`: `npm run build` or `npm run lint`, whichever the CI runs. `checkOn`: `[".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".css"]`.
- `permissions.allow`: `Bash(npm run *)`, `Bash(npm test *)`, `Bash(npm ci)`.
