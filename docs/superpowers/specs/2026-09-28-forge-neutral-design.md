# Forge-neutral setup and lean profiles

Date: 2026-09-28. Changes the layers of `2026-09-25-generic-template-design.md` (removed with this change, see git history) and the `flow` plugin's forge handling.

## Goal

The same clone of `claude-setup` works on private machines that use GitHub and on a company machine that uses a self-hosted GitLab, with one personal profile. The template and the plugin name no forge, organisation, repository, host or version; a profile holds only lasting personal preferences.

Success means:

1. `git grep` over `template/`, `plugins/`, `scripts/`, `tests/` and `README.md` finds no personal identifiers, repository names or private hosts; `profiles/` contains no host names, URLs or repository names (pinned by a layout test).
2. On a machine where `gh` is signed in, the installer writes a `Forges:` line into `machine.md` and a detected `Source control` line into `autoMode.environment`; the same holds for `glab`.
3. `/flow:ship` opens a pull request on GitHub, a merge request on GitLab (with `glab`, or through push options without it), and on any other forge pushes the branch and hands the user the description.
4. The guard asks before merges, releases and auto-merges on both forges and before pushes to the repository's default branch, whatever its name.
5. `node --test` passes on Windows and macOS in CI.
6. The owner's company machine installs with the owner's profile, and `/flow:setup-project` and `/flow:ship` work against its GitLab (manual check by the owner).

## Decisions

| Question | Decision |
| --- | --- |
| Profiles on several machines | One personal profile for all machines. Accounts and forges are detected per machine. |
| What a profile may contain | Lasting personal preferences only: language and working rules, model, effort, extra plugins, tools those plugins need. No repository names, hosts, accounts, versions or temporary facts. |
| Deploy targets, production hosts, package feeds | The project's own `CLAUDE.md` ("Release and deploy"), written by `/flow:setup-project`. The auto mode classifier reads CLAUDE.md content; it does not read `autoMode` from project settings. |
| Trust for source control | Generated per machine from the signed-in forge CLIs: on public hosts (`github.com`, `gitlab.com`, `bitbucket.org`) the user's namespace, on any other host the whole host. |
| Merge requests on GitLab | `glab` when it is signed in for the host, otherwise GitLab push options. |
| Forge support architecture | Detection in code (`forge.mjs`, tested), actions in the `ship` skill's text, risky commands in the guard (tested). |
| Stack knowledge in `setup-project` | Stays in the plugin, neutral: no product, host or registry names. The project's CI is the source of truth. |
| Dated documents of finished work in `docs/superpowers/` | Removed; git history keeps them. |

## Layers

### Template

`template/CLAUDE.md` speaks of "pull or merge requests", "the repository's default branch" and "the forge's CLI (`gh` for GitHub, `glab` for GitLab)". `template/settings.json` is unchanged.

### Profile

- `CLAUDE.md`: chat language and personal working rules. No accounts.
- `settings.json`: `model`, top-level `effortLevel` (not `modelSettings`, which is keyed by a model version), `autoUpdatesChannel`, extra `enabledPlugins`. No `autoMode` block.
- `setup.mjs`: optional, unchanged contract.
- `profiles/example/` shows exactly this shape.

### Machine

`scripts/lib/machine.mjs` adds `glab` to the tool list and detects forges:

- For each of `gh` and `glab` that is on the PATH, run `<cli> auth status` (timeout 15 s) and read stdout and stderr whatever the exit code; every `Logged in to <host> account <user>` or `Logged in to <host> as <user>` is one entry.
- `machine.json` gets `forges: [{ "cli": "gh", "host": "github.com", "user": "…" }]` (empty list when none).
- `machine.md` gets one line: "Forges: `gh` is signed in to github.com as `<user>`." or "No forge CLI is signed in; `/flow:ship` pushes the branch and GitLab merge requests come from push options."
- The installer prints `Forges: …` after the tools line.
- `autoMode.environment` gets, after the host line, `Source control (detected on this machine): github.com/<user> and the repositories under it; every repository on <self-hosted host>.` Only when at least one forge is signed in.
- `isMachineLine` recognises both generated lines, so `--pull` never writes them into a profile.

`machineEnvironmentLine` becomes `machineEnvironmentLines` (array); `layerSettings` and `pullToProfile` take the array.

### Machine-local auto mode entries

`autoMode` entries the user adds on a machine (with `/permissions` or `/auto-mode-setup`, for example a company's internal domains) stay on that machine: an install keeps every entry of `environment`, `allow`, `soft_deny` and `hard_deny` that is neither managed, generated for the machine, nor taken from a profile by the last install. `--pull` never writes `autoMode` into a profile. Installs that recorded no values replace `autoMode` as a whole.

### Stale profile keys

`installed.json` records the profile's values next to its keys. On install, a key the previous install took from a profile that the current layers no longer provide is removed from `~/.claude/settings.json`, unless the user changed its value since (then it stays). Without recorded values (installs before this change) the key is removed.

## Plugin

### `forge.mjs`

`plugins/flow/scripts/forge.mjs`, run from anywhere inside a repository, prints one JSON object:

```json
{ "remote": "origin", "host": "gitlab.example.com", "project": "group/sub/repo", "kind": "gitlab", "cli": "glab", "defaultBranch": "main" }
```

Logic in `plugins/flow/scripts/lib/forge.mjs`, with injected command runner:

- `parseRemote(url)`: `https://[user@]host[:port]/path(.git)`, `ssh://[user@]host[:port]/path(.git)` and `user@host:path(.git)` give `{ host, project }`; the host is lower-case without port.
- `forgeKind(host, { root, exists })`: `github.com` is `github`, `gitlab.com` is `gitlab`; a host containing `gitlab` or `github` is that forge; otherwise `.gitlab-ci.yml` in the repository means `gitlab`; otherwise `unknown`. An `unknown` host is the forge whose CLI (`glab`, then `gh`) is signed in there.
- `cli`: `gh` for `github`, `glab` for `gitlab`, when `<cli> auth status --hostname <host>` reports it signed in; otherwise `null`.
- `defaultBranch`: `git symbolic-ref --quiet --short refs/remotes/<remote>/HEAD` without the remote prefix; if unset, `git ls-remote --symref <remote> HEAD`; otherwise `null`.
- Outside a repository or without a remote it prints `{ "remote": null, … "kind": "unknown" }` and exits 0.

### `/flow:ship`

1. Guard: stop on the default branch (from `forge.mjs`), on `main`/`master` and on a detached HEAD.
2. Verify and review: unchanged.
3. Push and open the request, by `kind` and `cli`:
   - `github` with `gh`: as before (`gh pr view`, `gh pr create --body-file`, `gh pr checks`).
   - `gitlab` with `glab`: `git push -u <remote> HEAD`; `glab mr view` finds an existing merge request; otherwise `glab mr create --source-branch <branch> --target-branch <base> --title … --description "$(cat <file>)" --yes`; report the URL and `glab ci status` once.
   - `gitlab` without `glab`: `git push -u <remote> HEAD -o merge_request.create -o merge_request.target=<base> -o "merge_request.title=<title>"`; report the URL from the push output and give the user the description to paste.
   - Anything else: push, report the branch and give the user the description.
4. Never merge, never request auto-merge.

### Guard

`push-rules.mjs`:

- Protected branches are `main`, `master` and the default branch of the pushed remote (`refs/remotes/<remote>/HEAD`, looked up through an injected `defaultBranchOf(dir, remote)`; `origin` when the push names no remote or a URL).
- Push options with `merge_request.merge_when_pipeline_succeeds` or `merge_request.auto_merge` ask in every form git accepts: `-o <v>`, `-o<v>`, bundled `-uo <v>`, `--push-option[=]<v>` and its abbreviations, `git -c push.pushOption=<v>`. Bundled short flags (`-uf`) and abbreviated long flags (`--forc`) count like the full flags.
- `glab mr merge|accept`, any `glab mr` command with `--auto-merge`, `glab release create|update|delete|upload`, `glab repo delete|transfer|update`, `glab ci trigger|run|run-trig` ask, also through glab's aliases (`project`, `pipeline`, `pipe`, `ci create`, `mr new`).
- `gh workflow run` asks.
- `glab api` like `gh api`: non-GET calls to `merge_requests/<n>/merge`, `releases…`, `repository/tags…` or `jobs/<n>/play` ask.
- Messages name no project and end in "which may deploy" where a merge is involved.

### `/flow:setup-project`

- The default branch comes from `forge.mjs`.
- CI files of any forge are read: `.github/workflows/*.yml`, `.gitlab-ci.yml` and its local includes, `azure-pipelines.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, `.circleci/config.yml`.
- "Release and deploy" names what deploys or publishes (tags, merges to the default branch, deploy jobs and environments, manual and scheduled pipeline jobs) and the production hosts, environments and registries, because the auto mode classifier learns them from there.
- `stacks.md` keeps .NET, Python, Node and a neutral "Infrastructure as code" section (lint and validate only, never apply); other stacks are derived from the CI.

## Documentation

- README: prerequisites name `gh` or `glab`; the profile step states what a profile may contain; the machine layer lists forges; the guard table lists the GitLab rules and the default branch; "Fork for a team" no longer says the plugin knows GitHub only.
- Repo `CLAUDE.md`: the profile rule joins the rules.
- The dated documents of finished work in `docs/superpowers/` are deleted.

## Testing

- `tests/machine.test.mjs`: parsing both `auth status` formats, several hosts, no CLI, a failing CLI; the `Source control` line for public and self-hosted hosts; `isMachineLine` for both lines; `machine.md` forges line.
- `tests/settings.test.mjs`, `tests/install.test.mjs`: the array of machine lines; `--pull` leaves both out; stale profile keys are removed, changed ones stay.
- `tests/layout.test.mjs`: profiles contain no URL or host name and no `autoMode` block.
- `plugins/flow/tests/forge.test.mjs`: remote URL forms, kind detection, symref parsing, the script end to end in a temporary repository.
- `plugins/flow/tests/push-rules.test.mjs`: every new rule, including wrapped forms (`bash -c`, `env`, `wsl --`), and the default-branch rule with and without a known default.
- `plugins/flow/tests/hooks-e2e.test.mjs`: the guard asks for a push from a repository whose `origin/HEAD` points to a non-`main` branch.

## Out of scope

- Bitbucket or other forge CLIs.
- Organisations and groups on public hosts in the `Source control` line.
- A CI configuration for GitLab in this repository.
