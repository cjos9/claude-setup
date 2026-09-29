# claude-setup

A generic Claude Code setup for Windows, macOS and Linux: `template/` (settings and CLAUDE.md for everyone, status line), `profiles/example/` (the starting point for a person's own settings, CLAUDE.md and `setup.mjs`, which live in a folder and repository of their own), the local marketplace `claude-setup` with the plugin `plugins/flow` (hooks and skills), and the installer `scripts/install.mjs` behind `install.ps1` and `install.sh`. README.md is the handbook; specs, plans and build ledgers are in `docs/superpowers/`.

## Commands

- Tests: `node --test` in the repo root (CI runs them on Windows, macOS and Linux). Plugin check: `claude plugin validate plugins/flow`.
- Apply a change: commit, run `install.ps1` (Windows) or `./install.sh` (macOS, Linux); both call `scripts/install.mjs`, which merges settings and refreshes the cached plugin. Then restart Claude Code. Claude Code runs the plugin from a copy in `~/.claude/plugins/cache`, never from this folder.
- Try plugin changes without installing: `claude --plugin-dir plugins/flow`.

## Rules

- Hooks and installer are dependency-free Node ESM. Hook errors must fail open (exit 0, no stdout). guard-push answers `ask`, protect-files `deny`, check-on-stop blocks with `{"decision":"block"}`.
- Every guard change gets a test in `plugins/flow/tests`; each bypass found so far is pinned there.
- guard-push catches mistakes in commands as Claude writes them, not deliberate evasion. Pushes through shell expansion (`eval`, variables, `xargs`, piping into a shell), git aliases or scripts are left to auto mode's classifier and the forge's branch protection: don't grow the parser for them.
- Nothing personal in this repository: no personal profiles (only `profiles/example`), no user names, distros, versions, projects or hosts in `template/`, `plugins/`, `scripts/` or tests. Machine facts, forges and accounts come from `scripts/lib/machine.mjs`.
- Profiles hold lasting personal preferences only: no repository names, hosts, accounts, versions or temporary facts (pinned in `tests/layout.test.mjs` for the example).
- Code must run on Windows, macOS and Linux; inject the platform in tests instead of reading `process.platform`.
- README.md describes what exists and how to use it: no sentences that justify the design, recount history or reassure because of a past bug or fix (those go into commits and PRs).
- `install.ps1` stays pure ASCII and Windows PowerShell 5.1 compatible; `.sh` files use LF.

## Open work

Tracked as GitHub issues: `gh issue list`.
