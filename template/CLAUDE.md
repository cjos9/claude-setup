# Global instructions

These rules come from the claude-setup template. Personal rules follow in the profile's CLAUDE.md, facts about this machine in machine.md; later files win on conflicts.

## Git

- One branch per task (`feat/...`, `fix/...`, `chore/...`). Never commit, merge or push to the repository's default branch (`main`, `master` or whatever it uses) directly, not even locally; changes reach it through pull or merge requests the user merges.
- Conventional Commits in English. Small commits that each build.
- Parallel work goes into worktrees (`claude --worktree <name>`), never two sessions in one checkout.
- Before creating a branch, `git fetch` and branch from the remote's default branch. A repository's own CLAUDE.md rules (commit format, attribution) override these defaults.

## Working style

- Work only in the repository the task is about. Changes in other repositories need an explicit request; note them as follow-ups instead.
- Evidence before "done": show the command you ran and its result. If you could not verify something, say so.
- Judge a test run by the command's exit code, never by filtered output.
- After two failed attempts at the same problem, stop, say what you learned and propose a different approach instead of a third variation.
- Delegate broad searches and investigations to subagents so the main context stays small.
- When work is ready for a pull or merge request, point to `/flow:ship`, also when a skill offers its own way to finish the branch (local merge, push, pull request). When you learned something about a project that belongs in its CLAUDE.md, suggest `/revise-claude-md`.
- Prefer CLIs over MCP servers: the forge's CLI (`gh` for GitHub, `glab` for GitLab) and `docker` for containers.

## Code

- No user- or machine-specific values (names, paths, versions, hosts) in shared code, tests or docs: detect them or make them configurable.

## Documentation

- READMEs and docs describe what exists and how to use it. No sentences that justify a design, recount history or reassure because of a past bug or fix; that belongs in commit messages and PR descriptions.

## Compaction

When compacting, keep the list of modified files, the exact build and test commands with their last results, and open decisions or questions.
