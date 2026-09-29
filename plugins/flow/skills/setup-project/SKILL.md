---
name: setup-project
description: Set up Claude Code for the current repository - project CLAUDE.md, .claude/settings.json allowlist and .claude/flow.json check - on a branch, ready for a PR.
disable-model-invocation: true
argument-hint: "[notes about the project]"
---

# Set up this project for Claude Code

Notes from the user: $ARGUMENTS

Work through the steps in order. If a step's outcome is unclear, stop and ask; never guess a command.

## 1. Preconditions

- `git rev-parse --show-toplevel` must equal the current directory. Otherwise tell the user to start Claude at the repository root.
- `git status --short` must be empty. Otherwise stop and ask.
- `git fetch <remote>`, then create the branch from the remote's default branch, never from a stale local one: `git switch -c chore/claude-setup <remote>/<default>`. `node "${CLAUDE_SKILL_DIR}/../../scripts/forge.mjs"` prints the `remote` and the `defaultBranch`. If the checkout is on another branch, create a worktree instead of switching. If the repo has no remote or the default branch is `null`, ask. If the branch already exists, ask whether to reuse it.
- If `CLAUDE.md`, `.claude/settings.json` or `.claude/flow.json` exist, read them: update them instead of replacing them.

## 2. Learn the project

- Identify every stack in the repo with [stacks.md](stacks.md).
- Read the CI configuration, whichever forge the repository uses: `.github/workflows/*.yml`, `.gitlab-ci.yml` and the local files it `include:`s, `azure-pipelines.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, `.circleci/config.yml`. Read `README.md` and build scripts (`build.ps1`, `Makefile`, `justfile`, `pyproject.toml`, `package.json`). The CI's commands are the source of truth for build, test and lint.
- Note what deploys or publishes and when: tags, pushes or merges to the default branch, deploy jobs and their environments, manual and scheduled pipeline jobs, container images that servers pull automatically. Note the production hosts, environments and package registries. These are the most important facts in the CLAUDE.md: the auto mode classifier reads it too and learns from it which targets are sensitive.
- In a large repository, delegate this reading to a subagent and work from its summary.

## 3. Write CLAUDE.md

Fill [CLAUDE.template.md](CLAUDE.template.md):

- At most 80 lines. For every line ask: "Would Claude make a mistake without it?" If not, delete it.
- Only facts Claude cannot read from the code quickly: exact commands, non-obvious conventions, gotchas, release and deploy rules.
- No file-by-file tour, no generic advice, nothing the global CLAUDE.md already says.

## 4. Write .claude/settings.json and .claude/flow.json

- `settings.json`: `permissions.allow` with the stack's commands from stacks.md. Keep existing entries.
- `flow.json`: `check` is the fastest command that proves the code builds (plus lint if the CI lints). `checkOn` lists the file suffixes whose changes trigger the check. `test` is the CI's test command. `timeoutSec` is 300 unless the check is known to be slower, and must stay below 900 (the Stop hook itself is cancelled after 900 s). Add `"runIn": "linux"` for commands whose tools live in WSL on Windows (see stacks.md).

## 5. Ignore local files

Append the missing lines to `.gitignore`:

```gitignore
.claude/settings.local.json
.claude/.flow-state.json
.claude/worktrees/
```

## 6. Verify and commit

- Run the `check` command once and show the result. If it fails on the unchanged code, tell the user the project was already red and do not commit a check that cannot pass.
- Show `git diff --stat` and the new CLAUDE.md.
- Commit with `chore: set up Claude Code (CLAUDE.md, permissions, flow check)`, unless the project's CLAUDE.md sets other commit rules (subject case, scopes, no attribution lines): those win.
- Tell the user that `/flow:ship` opens the pull or merge request.
