# claude-setup

A Claude Code setup you install once per machine and then use for every project: global settings, global instructions, and the `flow` plugin that guards risky pushes and secrets, keeps the build green before Claude may stop, notifies you when Claude waits, and ships finished work as a pull or merge request (GitHub, GitLab). It runs on Windows, macOS and Linux.

**Contents**

1. [What you get](#1-what-you-get)
2. [Set up a machine](#2-set-up-a-machine)
3. [Set up a project](#3-set-up-a-project)
4. [The development workflow](#4-the-development-workflow)
5. [Working in parallel and on several machines](#5-working-in-parallel-and-on-several-machines)
6. [Reference](#6-reference)

## 1. What you get

The setup has up to four layers. The installer merges them into `~/.claude/settings.json` and imports their instructions into `~/.claude/CLAUDE.md`; later layers win on conflicts.

| Layer | Where | What it holds |
| --- | --- | --- |
| Template | `template/`, `plugins/flow/` | Settings for everyone (auto mode, deny rules for secrets, status line, plugins), working rules in `template/CLAUDE.md`, the `flow` plugin |
| Team (optional) | `team/` in a team's fork of this repository | Rules for everyone in the team: conventions, extra plugins, permission rules, trusted infrastructure (see [The team layer](#the-team-layer)) |
| Profile | A folder of your own outside this repository, started from `profiles/example/` | Your own values: model, effort, extra plugins, your language and working rules |
| Machine | `~/.claude/claude-setup/` | Generated on every install: OS, where Docker and Python run (host or WSL), Smart App Control, signed-in forge CLIs |

## 2. Set up a machine

Do this once per machine. It takes about five minutes.

### Step 1: Check the prerequisites

| Tool | Required | Check |
| --- | --- | --- |
| git | yes | `git --version` (on macOS without the Command Line Tools, this offers to install them) |
| Node.js (LTS) | yes | `node --version` |
| Claude Code, signed in | yes | `claude --version` |
| GitHub CLI (`gh`) or GitLab CLI (`glab`), signed in | for `/flow:ship`; on GitLab optional | `gh auth status`, `glab auth status` |
| Docker, uv, .NET SDK | only if your projects use them | detected by the installer |

### Step 2: Clone the repository

```bash
git clone <url of this repo> claude-setup
cd claude-setup
```

### Step 3: Create your profile

Your profile lives in a folder of your own next to `claude-setup`, not inside it, and in a private repository of your own. This repository only holds the example.

On your first machine, copy the example and put it under version control:

```bash
cp -r profiles/example ../claude-profile
git -C ../claude-profile init
```

On every further machine, clone your profile repository next to `claude-setup` instead: `git clone <url of your profile repo> ../claude-profile`.

Fill in the files:

| File | What to put in |
| --- | --- |
| `settings.json` | Only what differs from the template and holds on every machine you use: `model`, `effortLevel`, extra `enabledPlugins` (for example [superpowers](#optional-the-superpowers-workflow)). Permission lists add to the template's; other values replace it. |
| `CLAUDE.md` | The language Claude should chat in and your personal working rules. |
| `setup.mjs` | Optional. Installs tools your plugins need (for example a language server). It receives the path to `machine.json`. Delete it if you need nothing. |

A profile holds lasting personal preferences only: no repository names, hosts, accounts, versions or temporary facts. Accounts and forges are detected on each machine; deploy targets and production hosts go into each project's `CLAUDE.md`, which `/flow:setup-project` writes.

Commit the profile in its own repository and push it to a private repository on your forge, so your other machines can clone it.

### Step 4: Run the installer

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 --profile ../claude-profile
```

macOS and Linux (Terminal):

```bash
./install.sh --profile ../claude-profile
```

The installer backs up `~/.claude/settings.json` and `~/.claude/CLAUDE.md` to `~/.claude/backups/` (the 10 newest stay), detects the machine, registers the plugin marketplaces, installs missing plugins, merges the settings, imports the instructions and runs your profile's `setup.mjs`. Permission entries that an earlier install added and no layer provides any more are removed; entries you added yourself stay. On a machine that already has its own `settings.json`, the first install keeps your permission entries, plugins and auto mode entries, and names every value of yours it replaced (for example `statusLine.command`). It remembers the profile, so later runs need no arguments. A relative `--profile` path is looked up in the current folder first, then in the repository.

Without `--profile`, only the template is installed.

### Step 5: Restart Claude Code

Close every running Claude Code session and start a new one.

### Step 6: Check that everything works

- [ ] The installer's output has a `Machine:`, a `Tools on the host:` and a `Forges:` line that describe this machine correctly.
- [ ] `claude` shows the status line at the bottom.
- [ ] `/plugin` lists `flow` and the other plugins as enabled.
- [ ] `~/.claude/claude-setup/machine.md` names your OS and where Docker and Python run.
- [ ] A test notification appears: `echo '{"message":"test"}' | node plugins/flow/scripts/notify.mjs`

If one of these fails, see [Troubleshooting](#troubleshooting).

## 3. Set up a project

Do this once per repository, when you want Claude to know the project's commands and to run its build check.

1. Start Claude at the repository root: `cd <repo> && claude`.
2. Run `/flow:setup-project`. Claude reads the CI and build files and writes, on a branch `chore/claude-setup`:
   - `CLAUDE.md`: exact build, test and lint commands, conventions and gotchas, and above all what deploys or publishes (merges to the default branch, tags, deploy jobs) and which hosts are production.
   - `.claude/settings.json`: an allowlist for harmless commands such as `dotnet build` or `npm run lint`.
   - `.claude/flow.json`: the `check` the stop hook runs, the `test` command `/flow:ship` runs, and `runIn` where needed (see [flow.json](#claudeflowjson)).
3. Claude runs the check once. It must be green on the unchanged code.
4. Read the new `CLAUDE.md`. Correct anything wrong; it steers every future session.
5. Run `/flow:ship` to open the pull or merge request, then merge it.

## 4. The development workflow

One task, from idea to merged pull request. "You" is the developer, "Claude" is Claude Code with this setup.

### Step 1: Start from a fresh main

You:

```bash
git switch main && git pull
```

Once a week, also update the setup itself: `git pull` in `claude-setup` and in your profile repository, run the installer, restart Claude Code.

### Step 2: Start a session for the task

You start Claude in the repository:

- One task at a time: `claude`
- Several tasks in parallel: `claude --worktree <task-name>`, one worktree per task (see [section 5](#5-working-in-parallel-and-on-several-machines))

Auto mode is on: Claude works without asking for routine actions, and a classifier stops risky ones. `Shift+Tab` switches to plan mode or manual approval when you want more control.

### Step 3: Describe the task

You describe what you want and why, in a few sentences. Name constraints you know about (deadlines, APIs that must not change, performance limits).

For anything beyond a small change, switch to plan mode first (`Shift+Tab`): Claude reads the code, asks what it needs and proposes a plan, and nothing changes until you approve it. Answer its questions; say so when a question does not matter to you.

### Step 4: Let Claude implement

Claude creates a branch (`feat/…`, `fix/…`, `chore/…`) and implements the approved plan.

While Claude works, the setup protects you:

- **Stop check**: when relevant files changed on the branch, committed or not, Claude cannot end its turn while `.claude/flow.json`'s `check` fails. It fixes the build or tells you why the failure is unrelated.
- **Guards**: pushes to the default branch (`main`, `master` or the repository's own), tag pushes, force pushes, auto-merges and merges ask you first, also in auto mode. Approve only if you intend exactly that. Secrets (`.env`, keys) stay closed to Claude's file tools and shell file commands (see [What the guards do](#what-the-guards-do)).
- **Notifications**: when Claude waits for you, a desktop notification appears.

Your job in this step: answer questions, approve or reject prompts, and look at intermediate results when Claude reports them.

### Optional: the superpowers workflow

The `superpowers@claude-plugins-official` plugin replaces steps 3 and 4 with a stricter workflow. It is not part of the template; enable it in your profile's `enabledPlugins`.

Claude classifies the task and tells you which path it takes:

| Path | For | What you approve |
| --- | --- | --- |
| Spike | "Can we…?" questions | The question and how Claude will find out; you get a recommendation, no code to keep |
| Bounded | A contained change to existing code | A short design in the chat |
| Architectural | New features, new subsystems, changed interfaces | The design section by section, then the written spec, then the implementation plan and how to execute it |

Claude asks one question at a time and implements test-first: each behaviour gets a failing test, then the code that makes it pass. Specs and plans go into the project's `docs/superpowers/`. For an architectural plan you choose:

- **Inline**: Claude implements every task itself and one fresh reviewer checks the whole branch at the end. Cheaper and faster.
- **Subagent-driven**: a fresh subagent implements each task and a fresh reviewer checks it before the next one. Most thorough, most expensive.

When the branch is done, Claude points you to `/flow:ship` instead of merging or opening the request itself.

### Step 5: Ship the branch

You run `/flow:ship` (optionally with notes for the PR: `/flow:ship closes #12`). Claude then:

1. Stops if you are on `main` and offers to move the work to a branch.
2. Runs the project's `check` and `test` and keeps the results as evidence.
3. Reviews the diff in a fresh context and fixes real findings; dismissed findings get a one-line reason.
4. Commits with a Conventional Commit message and pushes the branch.
5. Opens the pull request (GitHub) or merge request (GitLab; with `glab`, or through push options without it) with a summary, the verification evidence, the review results and your notes, and reports the CI status once. On other forges it pushes the branch and gives you the description.

Claude never merges.

### Step 6: Review and merge

You read the pull or merge request: the summary, the diff, the evidence and the CI result. If something is off, say so in the session; Claude fixes it on the same branch and `/flow:ship` updates the request.

When you are satisfied, you merge.

### Step 7: Close the task

1. If Claude learned something about the project that the next session should know (a gotcha, a command, a convention), run `/revise-claude-md` and ship that change too.
2. Pull `main` and delete the merged branch: `git switch main && git pull && git branch -d <branch>`.
3. Run `/clear` before the next task, so it starts with a clean context.

## 5. Working in parallel and on several machines

**Parallel tasks.** Start each task with `claude --worktree <task-name>`. Every worktree has its own checkout and branch, so sessions never overwrite each other. Never run two sessions in one checkout. Remove a worktree when its branch is merged.

**Several machines.** Install the setup on each machine with the same profile, cloned from your profile repository. The machine layer takes care of the differences (for example Docker in WSL on Windows, native on macOS and Linux), and `.claude/flow.json` commands with `"runIn": "linux"` run in the right place on each.

**Keeping the profile in sync.** Changed something inside Claude Code, for example with `/model` or `/permissions`? Write it into your profile, commit, and pull it on the other machines:

```bash
./install.sh --pull                                                 # macOS, Linux
powershell -ExecutionPolicy Bypass -File install.ps1 --pull          # Windows
git -C ../claude-profile diff                                       # review, then commit and push
```

On the other machines: `git pull` in the profile repository, then run the installer. On a machine with its own changes, run `--pull` before `git pull`, so git merges both.

`--pull` writes into the profile installed on this machine. A key you removed inside Claude Code (for example `/model` set back to Default) is removed from the profile too. Template entries cannot be removed through a profile; they come back on the next install. A plugin the template no longer enables stays enabled on machines that had it, and `--pull` leaves it out of your profile: to keep it everywhere, add it to your profile's `enabledPlugins`. Auto mode entries (`autoMode`) are never pulled: they stay on the machine you added them on, and installs keep them.

## 6. Reference

### What the guards do

| Situation | Result |
| --- | --- |
| Push to the default branch (`main`, `master`, or the branch the remote's `HEAD` names; explicit or as current branch), tag push, force push, `--delete`/`--mirror`/`--all`, or a push whose branch the guard cannot determine (e.g. `--git-dir`) | Confirmation prompt, also in auto mode |
| Push options `merge_request.merge_when_pipeline_succeeds` or `merge_request.auto_merge`, also through `git -c push.pushOption=…` | Confirmation prompt |
| `gh pr merge`, `gh release create/edit/delete`, `gh repo edit/rename/archive/delete`, `gh workflow run`, `gh api` calls that merge or change releases | Confirmation prompt |
| `glab mr merge/accept`, any `glab mr` command with `--auto-merge`, `glab release create/update/upload/delete`, `glab repo update/transfer/delete`, `glab ci trigger/run/run-trig` (also through glab's aliases `project`, `pipeline`, `pipe`, `ci create`), `glab api` calls that merge, publish or play a job | Confirmation prompt |
| Read or write `.env`, `.env.*` (except `*.example`, `*.sample`, `*.template`, `*.dist`), keys and certificates (`*.key`, `*.pem`, `*.pfx`, `*.p12`) and private SSH keys with Claude's file tools, or read them with a file command in Bash (`cat`, `head`, `tail`, …) | Denied |
| Write into `.git/`, lockfiles, `*.sops.*`/`*.enc.*` files | Denied with a hint to the right tool |
| Claude waits for you | Desktop notification "Claude Code · <project>" (Windows toast, macOS Notification Center, `notify-send` on Linux) |
| Relevant files changed (uncommitted, or committed since the branch left the default branch) and `check` is red | Claude must keep working; each red state blocks once |

The secret rules do not cover a script or program that opens a file itself. To enforce them at the operating system level, enable Claude Code's sandbox with `/sandbox` (macOS, Linux and WSL2; not native Windows).

The push guard reads a command as it is written: a push through a variable, `eval`, a git alias or a script is left to auto mode's classifier. To enforce the push rules on the server, protect the default branch on your forge (on GitHub with a ruleset; private repositories need a paid plan for it).

### `.claude/flow.json`

| Key | Meaning |
| --- | --- |
| `check` | Fast command that proves the code builds (and lints); runs before Claude may stop |
| `checkOn` | File suffixes whose changes trigger the check |
| `test` | Full test command; used by `/flow:ship` |
| `runIn` | `"linux"`: on Windows run in the WSL distro from machine.json, on macOS and Linux run directly. Leave it out for commands that run on the host everywhere |
| `timeoutSec` | Default 300; keep it below 900, the stop hook itself is cancelled after 900 s |

The file is shared by every machine that works on the repository, so write commands that work on Windows, macOS and Linux.

### The team layer

A team's fork of this repository can add a `team/` folder. The installer picks it up on every install; nobody passes an option for it.

| File | What to put in |
| --- | --- |
| `team/settings.json` | Settings for everyone in the team, merged like a profile: permission lists and `autoMode.environment` add to the template's, other values replace them, and a profile's values win over the team's. The team's trusted infrastructure (hosts, registries, its forge) goes into `autoMode.environment`; `${TEAM}` stands for the folder's path. |
| `team/CLAUDE.md` | Team conventions. Claude reads them after the template's rules and before the profile's. |

`--pull` never writes into `team/`, and team entries stay out of profiles. Entries a team removes disappear from `settings.json` on the next install. Rules that users must not override belong in managed settings, which the organisation's administrators set up.

### Commands worth knowing

| Command | Use |
| --- | --- |
| `Shift+Tab` | Cycle permission modes (auto, manual, accept edits, plan) |
| `Esc` / `Esc Esc` | Stop Claude / rewind conversation and code to a checkpoint |
| `/clear` | Fresh context between unrelated tasks |
| `/compact <focus>` | Summarize the conversation, keeping what you name |
| `/btw <question>` | Side question that doesn't enter the context |
| `/context` | See what fills the context window |
| `/model fable`, `/effort max`, `ultrathink` | More reasoning for the hardest problems |
| `claude --continue`, `claude --resume` | Pick up the last or any earlier session |
| `/rename <name>` | Name a session so you can resume it later |
| `/code-review`, `/simplify`, `/security-review` | Built-in reviews of the current diff |
| `/permissions` → Recently denied | See and retry what auto mode blocked |
| `claude auto-mode config` | Show the classifier's effective rules |

### Changing the setup

After changing anything in this repository: commit, run the installer, restart Claude Code. If the path to the repository or the profile contains spaces, Claude Code reads copies of their `CLAUDE.md` files from `~/.claude/claude-setup/`, and only the installer refreshes those copies. To try plugin changes without installing: `claude --plugin-dir plugins/flow`. Tests: `node --test` (CI runs them on Windows, macOS and Linux).

### Fork for a team

A team, for example on a company GitLab, runs its own fork of this repository and keeps it in step with this one (upstream).

1. Create an empty repository on the team's forge and push this repository into it:

   ```bash
   git clone <url of this repo> claude-setup && cd claude-setup
   git remote rename origin upstream
   git remote add origin <url of the team repository>
   git push -u origin main
   ```

2. Put the team's rules into `team/` (see [The team layer](#the-team-layer)) on a branch and merge them through a merge request. Leave every other file as upstream has it, including `docs/superpowers/`.
3. Team members clone the team repository and [set up their machines](#2-set-up-a-machine) with their own profiles.

To bring upstream changes into the fork, the maintainer merges them on a branch and opens a merge request:

```bash
git fetch upstream
git switch -c chore/sync-upstream origin/main
git merge upstream/main
git push -u origin chore/sync-upstream
```

Changes that are not specific to the team go into upstream first and reach the fork with the next sync.

### Troubleshooting

- **A hook seems inactive**: `/hooks` lists what is loaded, `/plugin` shows plugin errors, `claude --debug` logs every hook run. Did you restart Claude Code after the install?
- **A plugin is missing**: run the installer again; it installs missing plugins and prints the command for any it could not install.
- **machine.md looks wrong** (for example after installing Docker or WSL, or Docker was not running during the install): run the installer again; it detects the machine on every run.
- **`/flow:ship` does not find your forge CLI**: run `gh auth status` or `glab auth status --hostname <host>`; after signing in, run the installer again so `machine.md` lists it.
- **Tests report "Zero tests ran" or `0x800711C7` on Windows**: Smart App Control blocked a fresh DLL. Run them through the `wsl` skill.
- **Auto mode keeps blocking a routine action**: add the destination under `/permissions` → Auto mode, or run `/auto-mode-setup`. The entry stays in this machine's `~/.claude/settings.json`; installs keep it and `--pull` leaves it out of your profile. Deploy targets and production hosts of one project belong in that project's `CLAUDE.md`.
- **The installer stops with "is not valid JSON"**: fix the named file (often a trailing comma after a hand edit) and run it again; nothing was changed.
