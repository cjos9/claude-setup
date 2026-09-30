---
name: ship
description: Finish the current branch - set the project up if it has no .claude/flow.json, run the project's check and tests, review the diff in a fresh context, fix real findings, commit, push the branch and open a pull or merge request with evidence.
disable-model-invocation: true
argument-hint: "[notes for the pull or merge request]"
---

# Ship the current branch

Notes from the user for the request: $ARGUMENTS

- Branch: !`git branch --show-current`
- Status: !`git status --short`

## 1. Guard

- Run `node "${CLAUDE_SKILL_DIR}/../../scripts/forge.mjs"`. Its JSON names the `remote`, the forge `kind` (`github`, `gitlab`, `unknown`), the signed-in `cli` (`gh`, `glab` or `null`) and the `defaultBranch`. The base branch is `defaultBranch`; if it is `null`, ask.
- Stop if the branch is the base branch, `main`, `master` or empty (detached HEAD). Offer to move the work to a new branch (`git switch -c <type>/<short-name>`) and ask for the name.

## 2. Set the project up

If `.claude/flow.json` exists, go on with step 3. Otherwise the project was never set up for Claude Code; set it up on this branch first:

- Skip the setup for a contribution to someone else's project: the checkout is a fork (it has an `upstream` remote, or the forge marks it as a fork) or the user does not maintain the project. If that is unclear, ask once. When you skip it, go on with step 3.
- Read `${CLAUDE_SKILL_DIR}/../setup-project/SKILL.md` and follow its steps 2 to 5; the files it links (`stacks.md`, `CLAUDE.template.md`) are in the same folder. Update an existing `CLAUDE.md` or `.claude/settings.json` instead of replacing it.
- Commit only the files these steps wrote, as a commit of its own, separate from the branch's other changes: `chore: set up Claude Code (CLAUDE.md, permissions, flow check)`, unless the project's CLAUDE.md sets other commit rules.
- Name the setup in the request's **Summary**, so the reviewer reads the new CLAUDE.md.

## 3. Verify

- Run `node "${CLAUDE_SKILL_DIR}/../../scripts/run-flow.mjs" check`, then `node "${CLAUDE_SKILL_DIR}/../../scripts/run-flow.mjs" test`. They run `.claude/flow.json`'s commands the way the stop hook does, including `"runIn": "linux"`. Without a flow.json, take the commands from the project CLAUDE.md; if there are none, ask.
- On Windows, tests that need Docker, or that the machine's application control blocks (see machine.md), run through the `wsl` skill.
- Keep the exact commands and their summary lines as evidence. A red result stops shipping: find the root cause before you change code (with superpowers:systematic-debugging if it is available) and fix it, or report it and stop.

## 4. Review

- Invoke the `code-review` skill on the diff against the base branch.
- Handle every finding (with superpowers:receiving-code-review if it is available): verify it against the code, fix only real problems, and note dismissed ones with a one-line reason.
- After fixes, run `check` and `test` again.

## 5. Commit

- Stage only the files that belong to the change. Never stage `.env*` files, `.claude/settings.local.json` or `.claude/.flow-state.json`.
- Commit with a Conventional Commit message in English. Keep existing commits; don't squash.
- Write the request description to a temporary file. Sections: **Summary** (bullets), **Verification** (commands and results), **Review** (findings fixed or dismissed with reason), **Notes** (the user's notes, if any). The title is a Conventional Commit subject.

## 6. Push and open the request

Pick the first case that matches the forge JSON:

- **`kind` github, `cli` gh**: `git push -u <remote> HEAD`. If `gh pr view --json url` finds a pull request for the branch, the push updated it. Otherwise `gh pr create --base <base> --title "<title>" --body-file <file>`. Report the URL and `gh pr checks` once.
- **`kind` gitlab, `cli` glab**: `git push -u <remote> HEAD`. If `glab mr view` finds a merge request for the branch, the push updated it. Otherwise `glab mr create --source-branch <branch> --target-branch <base> --title "<title>" --description "$(cat <file>)" --yes`. Report the URL and `glab ci status` once.
- **`kind` gitlab, no `cli`**: `git push -u <remote> HEAD -o merge_request.create -o merge_request.target=<base> -o "merge_request.title=<title>"`. GitLab prints the merge request URL in the push output; report it. Push options cannot carry the description: show the user the description so they can paste it.
- **Anything else**: `git push -u <remote> HEAD`, report the branch and show the user the description so they can open the request in the forge's web interface.

Never merge, and never ask the forge to merge automatically (no `gh pr merge --auto`, no `glab mr merge`, no auto-merge push option). Merging is the user's decision; in many projects a merge deploys.
