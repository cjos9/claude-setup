# Forge-neutral Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One personal profile works on GitHub and GitLab machines: forges and accounts are detected per machine, the plugin opens pull or merge requests on either forge, and the guard covers both.

**Architecture:** The installer's machine detection learns signed-in forge CLIs and turns them into a `Forges:` line in `machine.md` and a generated `Source control` line in `autoMode.environment`. The plugin gets a small tested `forge.mjs` that tells skills which forge, CLI and default branch a repository has; `/flow:ship` and `/flow:setup-project` branch on it. The guard learns `glab`, GitLab auto-merge push options and the remote's default branch.

**Tech Stack:** Node.js ESM without dependencies, `node:test`, Claude Code plugin skills (Markdown).

**Spec:** `docs/superpowers/specs/2026-09-28-forge-neutral-design.md`

## Global Constraints

- Hooks, installer and plugin scripts are dependency-free Node ESM. Hook errors fail open (exit 0, no stdout).
- Code runs on Windows and macOS; tests inject the platform and command runners instead of reading `process.platform`.
- Nothing personal outside `profiles/<name>/`. Profiles contain no repository names, hosts, URLs, accounts, versions or temporary facts.
- Every guard change gets a test in `plugins/flow/tests`.
- README and docs describe what exists and how to use it; no justification or history sentences.
- `install.ps1` stays pure ASCII; `.sh` files use LF.
- Commits: Conventional Commits in English, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Test command: `node --test` in the repository root; judge by exit code.

## Review Focus

- A remote URL with embedded credentials (`https://oauth2:token@host/...`): `forge.mjs` must never print the token. Pinned in Task 4.
- `gh api`/`glab api` with a value option (`-H "Accept: x"`) before the endpoint must not hide a merge. Pinned in Task 5.
- A repository whose only remote is not `origin`: `forge.mjs` must pick it. Pinned in Task 4.
- A default branch that cannot be looked up must not make every push ask. Pinned in Task 5.
- A value the user changed inside Claude Code must survive the stale-key cleanup when the profile drops the key. Pinned in Task 2.

---

### Task 1: Detect signed-in forges on the machine

**Files:**
- Modify: `scripts/lib/machine.mjs`
- Test: `tests/machine.test.mjs`

**Interfaces:**
- Produces: `defaultRun(file, args, opts) -> { ok, stdout, stderr }`; `parseAuthStatus(cli, text) -> [{ cli, host, user }]`; `machine.forges` (array, always present from `detectMachine`); `forgesLine(machine) -> string`; `sourceControlLine(machine) -> string | null`; `machineEnvironmentLines(machine) -> string[]` (host line first); `SOURCE_CONTROL_PREFIX`; `isMachineLine(line)` recognises the host and the source control line. `machineEnvironmentLine(machine)` keeps returning the host line.

- [ ] **Step 1: Write the failing tests**

In `tests/machine.test.mjs`, extend the import and make `fakeRun` accept `{ ok, stdout, stderr }` answers:

```js
import {
  detectMachine, forgesLine, isMachineLine, machineEnvironmentLine, machineEnvironmentLines, missingToolMessage,
  parseAuthStatus, renderMachineMd, sourceControlLine,
} from "../scripts/lib/machine.mjs";

// A fake command runner: `answers` maps "file arg1 arg2" prefixes to stdout or to a partial result;
// anything else fails.
function fakeRun(answers) {
  return (file, args) => {
    const line = [file, ...args].join(" ");
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    if (key === undefined) return { ok: false, stdout: "", stderr: "" };
    const answer = answers[key];
    return typeof answer === "string" ? { ok: true, stdout: answer, stderr: "" } : { ok: true, stdout: "", stderr: "", ...answer };
  };
}
```

Append:

```js
const GH_STATUS = [
  "github.com",
  "  ✓ Logged in to github.com account octo (keyring)",
  "  - Active account: true",
  "  ✓ Logged in to github.com account octo-work (keyring)",
  "  - Active account: false",
  "",
].join("\n");
const GLAB_STATUS = [
  "gitlab.example.com",
  "  ✓ Logged in to gitlab.example.com as jdoe (/Users/u/.config/glab-cli/config.yml)",
  "  ✓ Git operations for gitlab.example.com configured to use ssh protocol.",
  "gitlab.com",
  "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}",
  "",
].join("\n");

test("both auth status formats are read, failed hosts are skipped", () => {
  assert.deepEqual(parseAuthStatus("gh", GH_STATUS), [
    { cli: "gh", host: "github.com", user: "octo" },
    { cli: "gh", host: "github.com", user: "octo-work" },
  ]);
  assert.deepEqual(parseAuthStatus("glab", GLAB_STATUS), [{ cli: "glab", host: "gitlab.example.com", user: "jdoe" }]);
  assert.deepEqual(parseAuthStatus("gh", "You are not logged into any GitHub hosts."), []);
});

test("signed-in forges are detected from stdout and stderr, whatever the exit code", () => {
  const machine = detectMachine({
    platform: "darwin", arch: "arm64", release: "24.0.0",
    run: fakeRun({
      "which gh": "/opt/homebrew/bin/gh\n",
      "which glab": "/opt/homebrew/bin/glab\n",
      "gh auth status": GH_STATUS,
      "glab auth status": { ok: false, stderr: GLAB_STATUS },
    }),
  });
  assert.equal(machine.tools.glab, true);
  assert.deepEqual(machine.forges.map((forge) => `${forge.cli}:${forge.host}:${forge.user}`), [
    "gh:github.com:octo", "gh:github.com:octo-work", "glab:gitlab.example.com:jdoe",
  ]);
});

test("without forge CLIs the forge list is empty and nothing is probed", () => {
  const probed = [];
  const run = (file, args) => {
    probed.push([file, ...args].join(" "));
    return { ok: false, stdout: "", stderr: "" };
  };
  const machine = detectMachine({ platform: "darwin", arch: "arm64", release: "24.0.0", run });
  assert.deepEqual(machine.forges, []);
  assert.equal(probed.some((line) => line.includes("auth status")), false);
});

test("the source control line trusts a namespace on public hosts and a whole self-hosted host", () => {
  assert.equal(sourceControlLine({ forges: [] }), null);
  assert.equal(sourceControlLine({}), null);
  assert.equal(
    sourceControlLine({ forges: [
      { cli: "gh", host: "github.com", user: "octo" },
      { cli: "glab", host: "gitlab.example.com", user: "jdoe" },
      { cli: "glab", host: "gitlab.example.com", user: "bot" },
    ] }),
    "Source control (detected on this machine): github.com/octo and the repositories under it; every repository on gitlab.example.com.",
  );
});

test("the machine lines are the host line, then the source control line when a forge is signed in", () => {
  const mac = { os: "macos", arch: "arm64", docker: "native", python: "native" };
  assert.deepEqual(machineEnvironmentLines(mac), [machineEnvironmentLine(mac)]);
  const withForge = { ...mac, forges: [{ cli: "glab", host: "gitlab.example.com", user: "jdoe" }] };
  assert.deepEqual(machineEnvironmentLines(withForge), [machineEnvironmentLine(mac), sourceControlLine(withForge)]);
  assert.equal(machineEnvironmentLines(withForge).every(isMachineLine), true);
});

test("the forges line and machine.md name each signed-in CLI", () => {
  const forges = [{ cli: "gh", host: "github.com", user: "octo" }, { cli: "glab", host: "gitlab.example.com", user: "jdoe" }];
  assert.equal(forgesLine({ forges }), "Forges: gh is signed in to github.com as octo; glab is signed in to gitlab.example.com as jdoe.");
  assert.equal(forgesLine({ forges: [] }), "Forges: no forge CLI is signed in.");
  const base = { os: "macos", arch: "arm64", osVersion: "15.1", hookShell: "sh", tools: { git: true }, docker: "native", python: "none" };
  assert.match(renderMachineMd({ ...base, forges }), /- Forges: `gh` is signed in to github\.com as `octo`; `glab` is signed in to gitlab\.example\.com as `jdoe`\./);
  assert.match(renderMachineMd({ ...base, forges: [] }), /- No forge CLI is signed in: `\/flow:ship` pushes the branch/);
});
```

In the existing test "every machine line is recognised as one", add:

```js
  assert.equal(isMachineLine("Source control (detected on this machine): every repository on gitlab.example.com."), true);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/machine.test.mjs`
Expected: FAIL, `parseAuthStatus` (and the other new exports) are not exported.

- [ ] **Step 3: Implement**

In `scripts/lib/machine.mjs`:

```js
const TOOLS = ["git", "node", "gh", "glab", "docker", "uv", "python3", "dotnet", "jq"];
const FORGE_CLIS = ["gh", "glab"];
const PROBE_TIMEOUT_MS = 5000;
// `auth status` asks the forge's API whether each token still works.
const AUTH_TIMEOUT_MS = 15000;
// On these hosts only the user's own namespace is theirs; any other host is a company's own instance.
const PUBLIC_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
export const SOURCE_CONTROL_PREFIX = "Source control (detected on this machine): ";

export function defaultRun(file, args, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
```

After `detectSmartAppControl`:

```js
// gh prints "Logged in to <host> account <user>", glab "Logged in to <host> as <user>" (on stderr).
// Both exit non-zero when one of several hosts fails, so the text counts, not the exit code.
export function parseAuthStatus(cli, text) {
  const forges = [];
  for (const [, host, user] of text.matchAll(/Logged in to (\S+) (?:account|as) ([^\s(]+)/g)) {
    const forge = { cli, host: host.toLowerCase(), user };
    if (!forges.some((known) => known.host === forge.host && known.user === forge.user)) forges.push(forge);
  }
  return forges;
}

function detectForges(tools, run) {
  return FORGE_CLIS.filter((cli) => tools[cli]).flatMap((cli) => {
    const result = run(cli, ["auth", "status"], { timeoutMs: AUTH_TIMEOUT_MS });
    return parseAuthStatus(cli, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  });
}
```

In `detectMachine`, after `tools:` in the object literal add `forges: detectForges(tools, run),` (the object is built after `tools`, so declare it as a property: `const machine = { os: ..., tools, forges: detectForges(tools, run) };`).

After `machineEnvironmentLine`:

```js
export function sourceControlLine(machine) {
  const parts = [];
  for (const { host, user } of machine.forges ?? []) {
    const part = PUBLIC_HOSTS.has(host) ? `${host}/${user} and the repositories under it` : `every repository on ${host}`;
    if (!parts.includes(part)) parts.push(part);
  }
  return parts.length ? `${SOURCE_CONTROL_PREFIX}${parts.join("; ")}.` : null;
}

// Every autoMode.environment line that belongs to the machine, never to a profile.
export function machineEnvironmentLines(machine) {
  return [machineEnvironmentLine(machine), sourceControlLine(machine)].filter(Boolean);
}

export function forgesLine(machine) {
  const forges = machine.forges ?? [];
  if (forges.length === 0) return "Forges: no forge CLI is signed in.";
  return `Forges: ${forges.map((forge) => `${forge.cli} is signed in to ${forge.host} as ${forge.user}`).join("; ")}.`;
}
```

Replace `isMachineLine`:

```js
// Recognises the lines machineEnvironmentLines writes; they belong to the machine, never to a profile.
export const isMachineLine = (line) => /^Host: (Windows|macOS) workstation \(/.test(line) || line.startsWith(SOURCE_CONTROL_PREFIX);
```

In `renderMachineMd`, after the Docker/Python line:

```js
  const forges = machine.forges ?? [];
  lines.push(forges.length
    ? `- Forges: ${forges.map((forge) => `\`${forge.cli}\` is signed in to ${forge.host} as \`${forge.user}\``).join("; ")}. \`/flow:ship\` uses the CLI that matches the repository's remote.`
    : "- No forge CLI is signed in: `/flow:ship` pushes the branch, and on GitLab push options open the merge request.");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/machine.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/machine.mjs tests/machine.test.mjs
git commit -m "feat(install): detect signed-in gh and glab accounts per machine"
```

---

### Task 2: Install the machine lines and drop stale profile keys

**Files:**
- Modify: `scripts/lib/settings.mjs`, `scripts/install.mjs`
- Test: `tests/settings.test.mjs`, `tests/install.test.mjs`

**Interfaces:**
- Consumes: `machineEnvironmentLines`, `machineEnvironmentLine`, `forgesLine` from Task 1.
- Produces: `layerSettings(template, profile, machineLines)` and `pullToProfile(user, template, profile, machineLines, installedKeys)` accept a line, an array of lines or null; `dropStaleProfileKeys(user, previous, managed) -> settings`; `installed.json` = `{ profile, keys, values }`.

- [ ] **Step 1: Write the failing tests**

`tests/settings.test.mjs`: add `dropStaleProfileKeys` to the import and append:

```js
test("several machine lines come last, in order", () => {
  const SOURCE = "Source control (detected on this machine): every repository on gitlab.example.com.";
  const managed = layerSettings(template, {}, [HOST, SOURCE]);
  assert.deepEqual(managed.autoMode.environment, ["$defaults", HOST, SOURCE]);
  const user = mergeIntoUser({}, managed);
  user.autoMode.environment.push("Trusted internal domains: *.example.com");
  const pulled = pullToProfile(user, template, {}, [HOST, SOURCE]);
  assert.deepEqual(pulled.autoMode.environment, ["Trusted internal domains: *.example.com"]);
});

test("a key the profile dropped is removed unless the user changed it since", () => {
  const managed = { model: "opus" };
  const previous = { keys: ["model", "env", "effortLevel"], values: { model: "opus", env: { A: "1" }, effortLevel: "high" } };
  const user = { model: "opus", env: { A: "1" }, effortLevel: "max", theme: "dark" };
  assert.deepEqual(dropStaleProfileKeys(user, previous, managed), { model: "opus", effortLevel: "max", theme: "dark" });
  assert.deepEqual(dropStaleProfileKeys(user, { keys: ["effortLevel"] }, managed), { model: "opus", env: { A: "1" }, theme: "dark" }, "without recorded values");
  assert.deepEqual(dropStaleProfileKeys(user, null, managed), user);
});
```

`tests/install.test.mjs`: let `sandbox` take the machine facts and add tests.

```js
function sandbox(t, machine = MAC) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "setup-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const machineFile = path.join(home, "fake-machine.json");
  fs.writeFileSync(machineFile, JSON.stringify(machine));
  // … rest unchanged
}
```

In "--pull writes changes into the profile and never touches the template", replace the host-line assertion with:

```js
  assert.equal((pulled.autoMode?.environment ?? []).some((line) => line.startsWith("Host:")), false);
```

Append:

```js
const GITLAB_MAC = { ...MAC, tools: { ...MAC.tools, glab: true }, forges: [{ cli: "glab", host: "gitlab.example.com", user: "jdoe" }] };
const SOURCE = "Source control (detected on this machine): every repository on gitlab.example.com.";

test("a signed-in forge adds the source control line and a Forges line to the output", (t) => {
  const box = sandbox(t, GITLAB_MAC);
  const result = box.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Forges: glab is signed in to gitlab\.example\.com as jdoe\./);
  assert.deepEqual(box.json("settings.json").autoMode.environment, [
    "$defaults", "Host: macOS workstation (arm64); Docker runs on the host; Python runs on the host.", SOURCE,
  ]);
  assert.match(box.read("claude-setup/machine.md"), /`glab` is signed in to gitlab\.example\.com/);
});

test("--pull keeps the user's own autoMode lines and never the detected ones", (t) => {
  const box = sandbox(t, GITLAB_MAC);
  const profile = copyProfile(t);
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ model: "opus" }));
  box.run(["--profile", profile]);
  const settings = box.json("settings.json");
  settings.autoMode.environment.push("Trusted internal domains: *.example.com");
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  const result = box.run(["--pull"]);
  assert.equal(result.status, 0, result.stderr);
  const pulled = JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"));
  assert.deepEqual(pulled.autoMode.environment, ["Trusted internal domains: *.example.com"]);
});

test("a key the profile no longer has is removed, unless the user changed it since", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  const file = path.join(profile, "settings.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...original, env: { FOO: "1" }, outputStyle: "Explanatory" }));
  box.run(["--profile", profile]);
  const settings = box.json("settings.json");
  settings.outputStyle = "Learning";
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(file, JSON.stringify(original));
  const result = box.run([]);
  assert.equal(result.status, 0, result.stderr);
  const after = box.json("settings.json");
  assert.equal("env" in after, false);
  assert.equal(after.outputStyle, "Learning");
  assert.deepEqual(box.json("claude-setup/installed.json").values, JSON.parse(JSON.stringify(original)));
});

test("keys from an install that recorded no values are removed when the profile drops them", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  const file = path.join(profile, "settings.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...original, env: { FOO: "1" } }));
  box.run(["--profile", profile]);
  const installed = box.json("claude-setup/installed.json");
  fs.writeFileSync(path.join(box.home, ".claude", "claude-setup", "installed.json"), JSON.stringify({ profile: installed.profile, keys: installed.keys }));
  fs.writeFileSync(file, JSON.stringify(original));
  box.run([]);
  assert.equal("env" in box.json("settings.json"), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/settings.test.mjs tests/install.test.mjs`
Expected: FAIL, `dropStaleProfileKeys` is not exported; the Forges line is missing.

- [ ] **Step 3: Implement**

`scripts/lib/settings.mjs`: change the header comment's "the machine line" to "the machine lines", and in `layerSettings`:

```js
// template, then profile, then the machine lines: profile scalars win, permission lists and
// autoMode.environment are unions, enabledPlugins merge key by key, other objects merge shallowly.
export function layerSettings(template, profile = {}, machineLines = []) {
  // … loop unchanged …
  const lines = [machineLines].flat().filter(Boolean);
  if (lines.length > 0) {
    result.autoMode = { ...(result.autoMode ?? {}), environment: [...(result.autoMode?.environment ?? []), ...lines] };
  }
  return result;
}
```

Rename the parameter in `pullToProfile` to `machineLines = []` and pass it on. Append:

```js
// previous: installed.json of the last install. A key it took from a profile that no layer provides
// any more is removed, unless the user changed its value since; installs that recorded no values
// count as unchanged.
export function dropStaleProfileKeys(user, previous, managed) {
  const result = { ...user };
  const keys = Array.isArray(previous?.keys) ? previous.keys : [];
  for (const key of keys) {
    if (key in managed || !(key in result)) continue;
    if (previous.values && !deepEqual(result[key], previous.values[key])) continue;
    delete result[key];
  }
  return result;
}
```

`scripts/install.mjs`:

- Import `forgesLine`, `machineEnvironmentLine`, `machineEnvironmentLines` from `./lib/machine.mjs` and `dropStaleProfileKeys` from `./lib/settings.mjs`.
- `layers()` returns `machineLines: machine ? machineEnvironmentLines(machine) : []` instead of `machineLine`.
- In `pull()`, destructure `machineLines` and pass it to `pullToProfile`.
- In `main()`:

```js
    const { template, profileSettings, machineLines } = layers(profile, machine);
    log(`Machine: ${machineEnvironmentLine(machine)}`);
    log(toolsLine(machine));
    log(forgesLine(machine));
    const managed = layerSettings(template, profileSettings, machineLines);
    if (args.plugins) plugins({ claudeDir, managed, log });

    const previous = readJson(path.join(stateDir, INSTALLED), null);
    const next = mergeIntoUser(dropStaleProfileKeys(user, previous, managed), managed);
    // … unchanged …
    writeJson(path.join(stateDir, INSTALLED), { profile, keys: Object.keys(profileSettings), values: profileSettings });
```

- Update the `INSTALLED` comment: `// the profile, its keys and values the last install put into settings.json`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/settings.test.mjs tests/install.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/settings.mjs scripts/install.mjs tests/settings.test.mjs tests/install.test.mjs
git commit -m "feat(install): write the detected source control line and drop stale profile keys"
```

---

### Task 3: Lean profiles

**Files:**
- Modify: `profiles/<owner>/CLAUDE.md`, `profiles/<owner>/settings.json`, `profiles/example/CLAUDE.md`, `profiles/example/settings.json`
- Test: `tests/layout.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: profiles without `autoMode`, `modelSettings`, hosts or URLs.

- [ ] **Step 1: Write the failing test**

Replace the test "every profile has settings, rules and a setup script, and no host line" in `tests/layout.test.mjs`:

```js
// A host-like word: name.tld for the top-level domains people use for code hosting and servers.
const HOST = /:\/\/|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|dev|de|eu|app|cloud|ch|at)\b/i;

test("every profile has settings, rules and a setup script, and holds preferences only", () => {
  for (const name of fs.readdirSync(path.join(ROOT, "profiles"))) {
    const settings = json(`profiles/${name}/settings.json`);
    assert.ok(fs.existsSync(path.join(ROOT, "profiles", name, "CLAUDE.md")), name);
    assert.ok(fs.existsSync(path.join(ROOT, "profiles", name, "setup.mjs")), name);
    assert.equal(settings.autoMode, undefined, `${name}: trusted infrastructure is detected per machine or belongs in a project's CLAUDE.md`);
    assert.equal(settings.modelSettings, undefined, `${name}: modelSettings is keyed by a model version; use effortLevel`);
    for (const file of ["settings.json", "CLAUDE.md"]) {
      const text = fs.readFileSync(path.join(ROOT, "profiles", name, file), "utf8");
      assert.doesNotMatch(text, HOST, `${name}/${file} names a host or URL`);
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/layout.test.mjs`
Expected: FAIL on the owner's profile (`autoMode` present).

- [ ] **Step 3: Rewrite the profiles**

Owner profile `settings.json`:

```json
{
  "model": "opus[1m]",
  "effortLevel": "xhigh",
  "autoUpdatesChannel": "latest",
  "enabledPlugins": {
    "csharp-lsp@claude-plugins-official": true
  }
}
```

Owner profile `CLAUDE.md`: delete the `## Accounts` section and its line; keep Communication and Working with me.

`profiles/example/settings.json`:

```json
{
  "model": "opus",
  "effortLevel": "high",
  "enabledPlugins": {}
}
```

`profiles/example/CLAUDE.md`:

```markdown
# Personal instructions

## Communication

- Chat with me in <language>. Code, comments, commit messages and docs are in English.

## Working with me

- <Rules that hold in every project, for example how much Claude may do before asking.>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/layout.test.mjs tests/install.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add profiles tests/layout.test.mjs
git commit -m "refactor(profiles): keep only lasting personal preferences"
```

---

### Task 4: `forge.mjs` tells skills the forge, CLI and default branch

**Files:**
- Create: `plugins/flow/scripts/lib/forge.mjs`, `plugins/flow/scripts/forge.mjs`
- Test: `plugins/flow/tests/forge.test.mjs`

**Interfaces:**
- Produces: `parseRemote(url) -> { host, project } | null`; `forgeKind(host, { hasFile }) -> "github" | "gitlab" | "unknown"`; `parseSymref(output) -> string | null`; `signedIn(output, host) -> boolean`; `describeRepo(cwd, { run, exists }) -> { remote, host, project, kind, cli, defaultBranch }`; CLI `node plugins/flow/scripts/forge.mjs` prints that object as JSON and exits 0.

- [ ] **Step 1: Write the failing tests**

`plugins/flow/tests/forge.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describeRepo, forgeKind, parseRemote, parseSymref, signedIn } from "../scripts/lib/forge.mjs";
import { SCRIPTS, tempRepo } from "./helpers.mjs";

test("remote URLs of every form give host and project, never credentials", () => {
  assert.deepEqual(parseRemote("https://github.com/octo/app.git"), { host: "github.com", project: "octo/app" });
  assert.deepEqual(parseRemote("https://oauth2:secret@gitlab.example.com:8443/group/sub/app.git\n"), { host: "gitlab.example.com", project: "group/sub/app" });
  assert.deepEqual(parseRemote("ssh://git@gitlab.example.com:2222/group/app.git"), { host: "gitlab.example.com", project: "group/app" });
  assert.deepEqual(parseRemote("git@github.com:octo/app.git"), { host: "github.com", project: "octo/app" });
  assert.deepEqual(parseRemote("GIT@GitHub.com:Octo/App"), { host: "github.com", project: "Octo/App" });
  for (const local of ["C:/repos/app.git", "C:\\repos\\app.git", "/srv/app.git", "file:///srv/app.git", "../app"]) {
    assert.equal(parseRemote(local), null, local);
  }
});

test("the forge kind comes from the host, then from the repository's CI file", () => {
  assert.equal(forgeKind("github.com"), "github");
  assert.equal(forgeKind("gitlab.com"), "gitlab");
  assert.equal(forgeKind("gitlab.example.com"), "gitlab");
  assert.equal(forgeKind("github.example.com"), "github");
  assert.equal(forgeKind("git.example.com", { hasFile: (name) => name === ".gitlab-ci.yml" }), "gitlab");
  assert.equal(forgeKind("git.example.com"), "unknown");
  assert.equal(forgeKind(null), "unknown");
});

test("ls-remote --symref output gives the default branch", () => {
  assert.equal(parseSymref("ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n"), "develop");
  assert.equal(parseSymref("abc123\tHEAD\n"), null);
});

test("signedIn matches the host in both auth status formats", () => {
  assert.equal(signedIn("  ✓ Logged in to github.com account octo (keyring)", "github.com"), true);
  assert.equal(signedIn("  ✓ Logged in to gitlab.example.com as jdoe (config.yml)", "gitlab.example.com"), true);
  assert.equal(signedIn("  ✓ Logged in to gitlab.com as jdoe (config.yml)", "gitlab.example.com"), false);
  assert.equal(signedIn("  x gitlab.example.com: API call failed", "gitlab.example.com"), false);
});

// A fake runner for describeRepo: maps "file args" prefixes to results.
function fakeRun(answers) {
  return (file, args) => {
    const line = [file, ...args].join(" ");
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    return key === undefined ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: "", stderr: "", ...answers[key] };
  };
}

test("describeRepo picks the upstream's remote, the signed-in CLI and the advertised default branch", () => {
  const run = fakeRun({
    "git -C /r rev-parse --show-toplevel": { stdout: "/r\n" },
    "git -C /r rev-parse --abbrev-ref --symbolic-full-name @{upstream}": { stdout: "work/feat/x\n" },
    "git -C /r remote get-url work": { stdout: "git@gitlab.example.com:team/app.git\n" },
    "git -C /r remote": { stdout: "origin\nwork\n" },
    "git -C /r ls-remote --symref work HEAD": { stdout: "ref: refs/heads/trunk\tHEAD\n" },
    "glab auth status --hostname gitlab.example.com": { ok: false, stderr: "  ✓ Logged in to gitlab.example.com as jdoe (c)\n" },
  });
  assert.deepEqual(describeRepo("/r", { run, exists: () => false }), {
    remote: "work", host: "gitlab.example.com", project: "team/app", kind: "gitlab", cli: "glab", defaultBranch: "trunk",
  });
});

test("describeRepo uses the only remote when there is no origin and no upstream", () => {
  const run = fakeRun({
    "git -C /r rev-parse --show-toplevel": { stdout: "/r\n" },
    "git -C /r remote get-url upstream": { stdout: "https://github.com/octo/app.git\n" },
    "git -C /r remote": { stdout: "upstream\n" },
    "git -C /r symbolic-ref --quiet --short refs/remotes/upstream/HEAD": { stdout: "upstream/main\n" },
  });
  const repo = describeRepo("/r", { run, exists: () => false });
  assert.equal(repo.remote, "upstream");
  assert.equal(repo.defaultBranch, "main");
  assert.equal(repo.cli, null, "gh is not signed in");
});

test("forge.mjs prints the repository's forge as JSON", (t) => {
  const repo = tempRepo({ branch: "feat/x" });
  t.after(repo.cleanup);
  repo.git("remote", "add", "origin", "https://oauth2:secret@git.example.invalid/team/app.git");
  repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  repo.write(".gitlab-ci.yml", "test:\n  script: [true]\n");
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, "forge.mjs")], { cwd: repo.dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /secret/);
  assert.deepEqual(JSON.parse(result.stdout), {
    remote: "origin", host: "git.example.invalid", project: "team/app", kind: "gitlab", cli: null, defaultBranch: "develop",
  });
});

test("forge.mjs outside a repository reports an unknown forge and exits 0", () => {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, "forge.mjs")], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).kind, "unknown");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/flow/tests/forge.test.mjs`
Expected: FAIL, module `../scripts/lib/forge.mjs` not found.

- [ ] **Step 3: Implement**

`plugins/flow/scripts/lib/forge.mjs`:

```js
// Tells which forge hosts a repository's remote, whether its CLI is signed in there and which branch
// is the default, so skills do not guess. Every probe is a command that may fail.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const KNOWN_HOSTS = { "github.com": "github", "gitlab.com": "gitlab" };
export const CLI_OF = { github: "gh", gitlab: "glab" };

function defaultRun(file, args) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// https://[user[:token]@]host[:port]/path, ssh://[user@]host[:port]/path and user@host:path. Local
// paths (C:/x, /srv/x, file://) are no forge.
export function parseRemote(url) {
  const text = url.trim();
  if (/^[A-Za-z]:[\\/]/.test(text)) return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:@]+)(?::\d*)?\/(.+)$/i.exec(text) ?? /^(?:[^@/:]+@)?([^/:@]+):(?!\/)(.+)$/.exec(text);
  if (!match) return null;
  return { host: match[1].toLowerCase(), project: match[2].replace(/\/+$/, "").replace(/\.git$/, "") };
}

export function forgeKind(host, { hasFile = () => false } = {}) {
  if (!host) return "unknown";
  if (Object.hasOwn(KNOWN_HOSTS, host)) return KNOWN_HOSTS[host];
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("github")) return "github";
  return hasFile(".gitlab-ci.yml") ? "gitlab" : "unknown";
}

// `git ls-remote --symref <remote> HEAD` prints "ref: refs/heads/<branch>\tHEAD".
export function parseSymref(output) {
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output)?.[1] ?? null;
}

// gh: "Logged in to <host> account <user>", glab: "Logged in to <host> as <user>".
export function signedIn(output, host) {
  return [...output.matchAll(/Logged in to (\S+) (?:account|as) /g)].some(([, name]) => name.toLowerCase() === host);
}

// The current branch's upstream remote, else origin, else the first remote.
function pickRemote(git) {
  const remotes = git("remote").stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  const fromUpstream = upstream.ok ? remotes.find((name) => upstream.stdout.trim().startsWith(`${name}/`)) : undefined;
  return fromUpstream ?? (remotes.includes("origin") ? "origin" : remotes[0] ?? null);
}

function defaultBranch(git, remote) {
  const local = git("symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`);
  const ref = local.ok ? local.stdout.trim() : "";
  if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
  const advertised = git("ls-remote", "--symref", remote, "HEAD");
  return advertised.ok ? parseSymref(advertised.stdout) : null;
}

export function describeRepo(cwd, { run = defaultRun, exists = fs.existsSync } = {}) {
  const none = { remote: null, host: null, project: null, kind: "unknown", cli: null, defaultBranch: null };
  const git = (...args) => run("git", ["-C", cwd, ...args]);
  const top = git("rev-parse", "--show-toplevel");
  if (!top.ok) return none;
  const root = top.stdout.trim();
  const remote = pickRemote(git);
  if (!remote) return none;
  const url = git("remote", "get-url", remote);
  const parsed = url.ok ? parseRemote(url.stdout) : null;
  const kind = forgeKind(parsed?.host, { hasFile: (name) => exists(path.join(root, name)) });
  const cli = parsed && Object.hasOwn(CLI_OF, kind) ? CLI_OF[kind] : null;
  const auth = cli ? run(cli, ["auth", "status", "--hostname", parsed.host]) : null;
  return {
    remote,
    host: parsed?.host ?? null,
    project: parsed?.project ?? null,
    kind,
    cli: auth && signedIn(`${auth.stdout}\n${auth.stderr}`, parsed.host) ? cli : null,
    defaultBranch: defaultBranch(git, remote),
  };
}
```

`plugins/flow/scripts/forge.mjs`:

```js
#!/usr/bin/env node
// Prints, as JSON, the forge of the repository around the current directory: remote, host, project,
// kind (github, gitlab, unknown), the signed-in CLI (gh, glab or null) and the default branch.
// Used by the ship and setup-project skills.
import { describeRepo } from "./lib/forge.mjs";

console.log(JSON.stringify(describeRepo(process.cwd()), null, 2));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test plugins/flow/tests/forge.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/flow/scripts/forge.mjs plugins/flow/scripts/lib/forge.mjs plugins/flow/tests/forge.test.mjs
git commit -m "feat(flow): detect a repository's forge, CLI and default branch"
```

---

### Task 5: The guard knows GitLab and the default branch

**Files:**
- Modify: `plugins/flow/scripts/lib/push-rules.mjs`, `plugins/flow/scripts/guard-push.mjs`
- Test: `plugins/flow/tests/push-rules.test.mjs`, `plugins/flow/tests/hooks-e2e.test.mjs`

**Interfaces:**
- Produces: `assessCommand(command, { branchOf, defaultBranchOf, shell })`; `defaultBranchOf(dir, remote) -> string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/flow/tests/push-rules.test.mjs`:

```js
const withDefault = (branch, defaultBranch) => ({ branchOf: () => branch, defaultBranchOf: () => defaultBranch });

test("the remote's default branch is protected like main, whatever its name", () => {
  assert.match(assessCommand("git push", withDefault("develop", "develop")) ?? "", /develop/);
  assert.match(assessCommand("git push origin develop", withDefault("feat/x", "develop")) ?? "", /develop/);
  assert.match(assessCommand("git push origin HEAD:refs/heads/develop", withDefault("feat/x", "develop")) ?? "", /develop/);
  assert.equal(assessCommand("git push", withDefault("feat/x", "develop")), null);
  assert.match(assessCommand("git push", withDefault("main", "develop")) ?? "", /main/, "main and master stay protected");
  assert.equal(assessCommand("git push", withDefault("develop", null)), null, "an unknown default branch adds nothing");
});

test("the default branch is looked up for the pushed remote", () => {
  const seen = [];
  const options = { branchOf: () => "feat/x", defaultBranchOf: (dir, remote) => { seen.push(remote); return null; } };
  for (const command of ["git push upstream", "git push", "git push https://example.com/x.git feat/x"]) assessCommand(command, options);
  assert.deepEqual(seen, ["upstream", "origin", "origin"]);
});

test("push options that merge automatically ask; other push options pass", () => {
  for (const command of [
    "git push -o merge_request.create -o merge_request.merge_when_pipeline_succeeds",
    "git push -u origin HEAD -o merge_request.auto_merge",
    "git push --push-option=merge_request.merge_when_pipeline_succeeds",
    "git push --push-option merge_request.auto_merge origin feat/x",
    "git push -omerge_request.auto_merge",
    `bash -c "git push -o merge_request.auto_merge"`,
  ]) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /merges automatically/, command);
  }
  for (const command of [
    "git push -u origin HEAD -o merge_request.create -o merge_request.target=main",
    `git push -o "merge_request.title=feat: x" -o ci.skip`,
  ]) {
    assert.equal(assessCommand(command, on("feat/x")), null, command);
  }
});

test("glab merges, releases, repository changes and pipelines ask; other glab commands pass", () => {
  for (const command of [
    "glab mr merge 12", "glab mr accept 12 --squash", "glab release create v1.0.0", "glab release delete v1",
    "glab release upload v1 a.zip", "glab repo delete group/app", "glab repo transfer group/app --target-namespace other",
    "glab ci trigger 123", "glab ci run -b main",
  ]) {
    assert.ok(assessCommand(command, on("feat/x")), command);
  }
  for (const command of ["glab mr create --fill --yes", "glab mr view", "glab ci status", "glab repo view", "glab release list"]) {
    assert.equal(assessCommand(command, on("main")), null, command);
  }
});

test("gh workflow run asks, other gh workflow commands pass", () => {
  assert.match(assessCommand("gh workflow run deploy.yml", on("feat/x")) ?? "", /workflow/);
  assert.equal(assessCommand("gh workflow list", on("feat/x")), null);
});

test("glab api calls that merge or publish ask; reads pass", () => {
  for (const command of [
    "glab api -X PUT projects/42/merge_requests/5/merge",
    "glab api --method POST projects/group%2Fapp/releases -f tag_name=v1",
    "glab api projects/42/repository/tags -f tag_name=v1 -f ref=main",
    "glab api -X POST projects/42/jobs/77/play",
  ]) {
    assert.match(assessCommand(command, on("feat/x")) ?? "", /glab api/, command);
  }
  for (const command of ["glab api projects/42/merge_requests/5", "glab api projects/42/releases"]) {
    assert.equal(assessCommand(command, on("feat/x")), null, command);
  }
});

test("a value option before the endpoint does not hide a merge", () => {
  assert.match(assessCommand(`gh api -H "Accept: application/json" -X PUT repos/o/r/pulls/5/merge`, on("feat/x")) ?? "", /gh api/);
  assert.match(assessCommand(`glab api --header "X: y" -X PUT projects/1/merge_requests/2/merge`, on("feat/x")) ?? "", /glab api/);
  assert.match(assessCommand(`gh api --hostname github.example.com -X PUT repos/o/r/pulls/5/merge`, on("feat/x")) ?? "", /gh api/);
});

test("wrapped glab merges ask", () => {
  assert.match(assessCommand(`bash -c "glab mr merge 3"`, on("feat/x")) ?? "", /merge/);
  assert.match(assessCommand("wsl -- glab mr merge 3", on("feat/x")) ?? "", /merge/);
  assert.match(assessCommand("env GITLAB_TOKEN=x glab release create v1", on("feat/x")) ?? "", /release/);
});
```

In the existing test "merge messages name no project", extend the list:

```js
  for (const command of ["gh pr merge 5", "gh api -X PUT repos/o/r/pulls/5/merge", "glab mr merge 5", "glab api -X PUT projects/1/merge_requests/5/merge", "git push -o merge_request.auto_merge"]) {
```

Append to `plugins/flow/tests/hooks-e2e.test.mjs` (after the `guard` helper is defined):

```js
test("guard-push asks before a push from the remote's default branch, whatever its name", (t) => {
  const repo = tempRepo({ branch: "develop" });
  t.after(repo.cleanup);
  assert.equal(guard("git push", repo.dir).stdout, "", "without a known default branch develop is a feature branch");
  repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  const result = guard("git push", repo.dir);
  assert.equal(decision(result.stdout), "ask");
  assert.match(reasonOf(result.stdout), /develop/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/flow/tests/push-rules.test.mjs plugins/flow/tests/hooks-e2e.test.mjs`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement in `push-rules.mjs`**

Replace the constants at the top:

```js
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const RISKY_PUSH_FLAGS = new Set([
  "--tags", "--follow-tags", "--mirror", "--all", "--delete", "-d", "--prune",
  "--force", "-f", "--force-with-lease", "--force-if-includes",
]);
const PUSH_OPTIONS_WITH_VALUE = new Set(["--repo", "--receive-pack", "--exec"]);
// GitLab push options that merge the merge request as soon as its pipeline passes.
const AUTO_MERGE_OPTION = /^merge_request\.(merge_when_pipeline_succeeds|auto_merge)(=|$)/;
const GIT_OPTIONS_WITH_VALUE = new Set(["-c", "--git-dir", "--work-tree", "--namespace"]);
const FORGE_RISKS = {
  gh: {
    pr: { merge: "gh pr merge merges into the base branch, which may deploy" },
    release: {
      create: "gh release create publishes a release",
      edit: "gh release edit changes a published release",
      delete: "gh release delete removes a release",
    },
    repo: {
      edit: "gh repo edit changes repository settings",
      rename: "gh repo rename renames a repository",
      archive: "gh repo archive archives a repository",
      delete: "gh repo delete deletes a repository",
    },
    workflow: { run: "gh workflow run starts a workflow, which may deploy" },
  },
  glab: {
    mr: {
      merge: "glab mr merge merges into the target branch, which may deploy",
      accept: "glab mr accept merges into the target branch, which may deploy",
    },
    release: {
      create: "glab release create publishes a release",
      update: "glab release update changes a published release",
      upload: "glab release upload changes a published release",
      delete: "glab release delete removes a release",
    },
    repo: {
      update: "glab repo update changes repository settings",
      transfer: "glab repo transfer moves a repository to another namespace",
      delete: "glab repo delete deletes a repository",
    },
    ci: {
      trigger: "glab ci trigger starts a manual job, which may deploy",
      run: "glab ci run starts a pipeline, which may deploy",
      "run-trig": "glab ci run-trig starts a pipeline, which may deploy",
    },
  },
};
// REST endpoints that merge or publish, per CLI.
const API_RISKY_ENDPOINT = {
  gh: /(^|\/)(pulls\/\d+\/merge|merges|releases(\/.*)?)$/,
  glab: /(^|\/)(merge_requests\/\d+\/merge|releases(\/.*)?|repository\/tags(\/.*)?|jobs\/\d+\/play)$/,
};
const API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
// Options of `gh api`/`glab api` whose value is the next word and never the endpoint.
const API_OPTIONS_WITH_VALUE = new Set(["-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache"]);
```

Remove the old `GH_RISKS`, `GH_API_RISKY_ENDPOINT` and `GH_API_FIELD_FLAGS`.

Replace `refspecRisk`:

```js
function refspecRisk(spec, currentBranch, isProtected) {
  if (spec.startsWith("+")) return `git push ${spec} force-updates the remote ref`;
  if (spec.startsWith(":")) return `git push ${spec} deletes a remote ref`;
  const destination = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
  if (destination.startsWith("refs/tags/") || /^v\d/.test(destination)) return `git push publishes tag ${destination}`;
  if (destination === "HEAD" || destination === "@") {
    const branch = currentBranch();
    if (branch == null) return UNKNOWN_BRANCH;
    return isProtected(branch) ? `git push targets ${branch}` : null;
  }
  const target = destination.replace(/^refs\/heads\//, "");
  return isProtected(target) ? `git push targets ${target}` : null;
}

// -o <v>, -o<v>, --push-option <v>, --push-option=<v>
function pushOption(arg, next) {
  if (arg === "-o" || arg === "--push-option") return { value: next ?? "", consumesNext: true };
  if (arg.startsWith("--push-option=")) return { value: arg.slice("--push-option=".length), consumesNext: false };
  if (/^-o./.test(arg)) return { value: arg.slice(2), consumesNext: false };
  return null;
}
```

In `assessGitPush`, replace the push-argument loop and everything after it:

```js
  const flags = [];
  const positionals = [];
  let autoMerge = null;
  const pushArgs = args.slice(i + 1);
  for (let j = 0; j < pushArgs.length; j++) {
    const arg = pushArgs[j];
    const option = pushOption(arg, pushArgs[j + 1]);
    if (option) {
      if (option.consumesNext) j++;
      if (AUTO_MERGE_OPTION.test(option.value)) autoMerge = option.value;
      continue;
    }
    if (PUSH_OPTIONS_WITH_VALUE.has(arg)) { j++; continue; }
    if (arg.startsWith("-")) { flags.push(arg.split("=")[0]); continue; }
    // Filter out shell redirections (>, >>, <, 2>, &>, 2>&1, >&2, >file, &>file, etc.)
    if (isRedirection(arg)) {
      if (needsFilenameToken(arg)) j++; // Skip filename token after operators like >, >>, <, 2>, 2>>, &>, &>>
      continue;
    }
    positionals.push(arg);
  }

  const risky = flags.find((flag) => RISKY_PUSH_FLAGS.has(flag));
  if (risky) return `git push ${risky} rewrites, deletes or publishes more than one feature branch`;
  if (autoMerge) return `git push -o ${autoMerge} merges automatically once the pipeline passes, which may deploy`;

  // "" is a detached HEAD (nothing to push by default); null means the branch could not be read.
  const currentBranch = () => (gitDir === UNKNOWN_DIR ? null : ctx.lookup(gitDir));
  // main, master and the default branch the pushed remote advertises; a URL counts as origin.
  const remote = positionals[0] && /^[\w.-]+$/.test(positionals[0]) ? positionals[0] : "origin";
  let protectedBranches = null;
  const isProtected = (branch) => {
    if (!protectedBranches) {
      const extra = gitDir === UNKNOWN_DIR ? null : ctx.lookupDefault(gitDir, remote);
      protectedBranches = extra ? new Set([...PROTECTED_BRANCHES, extra]) : PROTECTED_BRANCHES;
    }
    return protectedBranches.has(branch);
  };
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    const branch = currentBranch();
    if (branch == null) return UNKNOWN_BRANCH;
    return isProtected(branch) ? `git push from ${branch} publishes directly to ${branch}` : null;
  }
  for (const spec of refspecs) {
    const reason = refspecRisk(spec, currentBranch, isProtected);
    if (reason) return reason;
  }
  return null;
```

Replace `assessGhApi` and `assessGh`:

```js
// gh api and glab api send GET unless -X/--method says otherwise or fields are given (then POST).
function assessApi(cli, args) {
  let method = null;
  let hasFields = false;
  let endpoint = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const inline = /^(?:-X|--method=?)(.+)$/.exec(arg);
    if (inline) method = inline[1];
    else if (arg === "-X" || arg === "--method") method = args[++i];
    else if (API_FIELD_FLAGS.has(arg)) { hasFields = true; i++; }
    else if (/^(-f|-F|--field|--raw-field|--input)=/.test(arg)) hasFields = true;
    else if (API_OPTIONS_WITH_VALUE.has(arg)) i++;
    else if (!arg.startsWith("-") && endpoint === null) endpoint = arg;
  }
  const verb = (method ?? (hasFields ? "POST" : "GET")).toUpperCase();
  if (verb === "GET" || !endpoint || !API_RISKY_ENDPOINT[cli].test(endpoint.split("?")[0])) return null;
  return `${cli} api ${verb} ${endpoint} merges or publishes, which may deploy`;
}

function assessForgeCli(cli, args) {
  const [group, action] = args;
  if (group === "api") return assessApi(cli, args.slice(1));
  const risks = Object.hasOwn(FORGE_RISKS[cli], group) ? FORGE_RISKS[cli][group] : null;
  return risks && Object.hasOwn(risks, action) ? risks[action] : null;
}
```

In `assessWords`, replace `case "gh": return assessGh(args);` with:

```js
    case "gh": case "glab": return assessForgeCli(program, args);
```

Replace `assessCommand`:

```js
// branchOf(dir) answers the current branch of dir (null = the hook's cwd): a name, "" for a
// detached HEAD, or null when it cannot be determined. defaultBranchOf(dir, remote) answers the
// remote's default branch as the repository in dir knows it, or null. shell is "bash" or "powershell".
export function assessCommand(command, { branchOf = () => null, defaultBranchOf = () => null, shell = "bash" } = {}) {
  const cache = new Map();
  const cached = (key, answer) => {
    if (!cache.has(key)) cache.set(key, answer());
    return cache.get(key);
  };
  const lookup = (dir) => cached(`branch\0${dir ?? ""}`, () => branchOf(dir));
  const lookupDefault = (dir, remote) => cached(`default\0${dir ?? ""}\0${remote}`, () => defaultBranchOf(dir, remote));
  return assessText(command, { dir: null, linux: false, subshells: shell !== "powershell", depth: 0, lookup, lookupDefault });
}
```

Update the header comment of the file to: `// Decides whether a shell command publishes somewhere protected and needs the user's confirmation: pushes to the default branch, tags, force pushes, auto-merges, and merges or releases through gh or glab.`

- [ ] **Step 4: Implement in `guard-push.mjs`**

Replace `branchResolver` with a shared helper and two resolvers:

```js
// Runs git in a directory taken from the command (null = the hook's cwd); null when it cannot.
function gitIn(cwd, dir, args) {
  try {
    const native = dir === null ? cwd : nativeDir(dir, { cygpath });
    if (native === null) return null;
    return execFileSync("git", ["-C", path.resolve(cwd, native), ...args], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// The current branch of a directory: its name, "" for a detached HEAD, null when unknown.
const branchResolver = (cwd) => (dir) => gitIn(cwd, dir, ["branch", "--show-current"]);

// The remote's default branch as the local clone knows it (refs/remotes/<remote>/HEAD), or null.
const defaultBranchResolver = (cwd) => (dir, remote) => {
  const ref = gitIn(cwd, dir, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  return ref?.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : null;
};
```

And in the hook body:

```js
  const cwd = input.cwd ?? process.cwd();
  const reason = assessCommand(command, {
    branchOf: branchResolver(cwd),
    defaultBranchOf: defaultBranchResolver(cwd),
    shell: input.tool_name === "PowerShell" ? "powershell" : "bash",
  });
```

Update the header comment: `// PreToolUse hook: asks the user before Claude pushes to the default branch (or main/master), pushes tags, force-pushes, requests an auto-merge, merges a pull or merge request, starts a deploy-capable pipeline or publishes a release. Every other command passes untouched.`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test plugins/flow/tests`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add plugins/flow/scripts/lib/push-rules.mjs plugins/flow/scripts/guard-push.mjs plugins/flow/tests/push-rules.test.mjs plugins/flow/tests/hooks-e2e.test.mjs
git commit -m "feat(flow): guard GitLab merges, auto-merge push options and the default branch"
```

---

### Task 6: Forge-neutral skills

**Files:**
- Modify: `plugins/flow/skills/ship/SKILL.md`, `plugins/flow/skills/setup-project/SKILL.md`, `plugins/flow/skills/setup-project/stacks.md`, `plugins/flow/skills/setup-project/CLAUDE.template.md`
- Create: `plugins/flow/tests/skills.test.mjs`

**Interfaces:**
- Consumes: `forge.mjs` JSON from Task 4 (`remote`, `host`, `kind`, `cli`, `defaultBranch`).

- [ ] **Step 1: Write the failing test**

`plugins/flow/tests/skills.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = (name) => fs.readFileSync(path.join(PLUGIN, "skills", name, "SKILL.md"), "utf8");

test("skills call scripts that exist", () => {
  for (const name of ["ship", "setup-project"]) {
    const scripts = [...skill(name).matchAll(/\$\{CLAUDE_SKILL_DIR\}\/\.\.\/\.\.\/scripts\/([\w-]+\.mjs)/g)].map(([, file]) => file);
    assert.ok(scripts.includes("forge.mjs"), `${name} asks forge.mjs`);
    for (const file of scripts) assert.ok(fs.existsSync(path.join(PLUGIN, "scripts", file)), `${name}: ${file}`);
  }
});

test("ship covers GitHub, GitLab with and without glab, and other forges, and never merges", () => {
  const text = skill("ship");
  for (const needle of ["gh pr create", "glab mr create", "merge_request.create", "Never merge"]) assert.ok(text.includes(needle), needle);
  assert.doesNotMatch(text, /-o merge_request\.(auto_merge|merge_when_pipeline_succeeds)/);
});

test("setup-project reads the CI of any forge", () => {
  const text = skill("setup-project");
  for (const needle of [".github/workflows", ".gitlab-ci.yml"]) assert.ok(text.includes(needle), needle);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/flow/tests/skills.test.mjs`
Expected: FAIL (`forge.mjs` not referenced; `glab mr create` missing).

- [ ] **Step 3: Rewrite `ship/SKILL.md`**

```markdown
---
name: ship
description: Finish the current branch - run the project's check and tests, review the diff in a fresh context, fix real findings, commit, push the branch and open a pull or merge request with evidence.
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

## 2. Verify

- Run `node "${CLAUDE_SKILL_DIR}/../../scripts/run-flow.mjs" check`, then `node "${CLAUDE_SKILL_DIR}/../../scripts/run-flow.mjs" test`. They run `.claude/flow.json`'s commands the way the stop hook does, including `"runIn": "linux"`. Without a flow.json, take the commands from the project CLAUDE.md; if there are none, ask.
- On Windows, tests that need Docker, or that the machine's application control blocks (see machine.md), run through the `wsl` skill.
- Keep the exact commands and their summary lines as evidence. A red result stops shipping: fix it with superpowers:systematic-debugging, or report it and stop.

## 3. Review

- Invoke the `code-review` skill on the diff against the base branch.
- Handle every finding with superpowers:receiving-code-review: verify it, fix only real problems, and note dismissed ones with a one-line reason.
- After fixes, run `check` and `test` again.

## 4. Commit

- Stage only the files that belong to the change. Never stage `.env*` files, `.claude/settings.local.json` or `.claude/.flow-state.json`.
- Commit with a Conventional Commit message in English. Keep existing commits; don't squash.
- Write the request description to a temporary file. Sections: **Summary** (bullets), **Verification** (commands and results), **Review** (findings fixed or dismissed with reason), **Notes** (the user's notes, if any). The title is a Conventional Commit subject.

## 5. Push and open the request

Pick the first case that matches the forge JSON:

- **`kind` github, `cli` gh**: `git push -u <remote> HEAD`. If `gh pr view --json url` finds a pull request for the branch, the push updated it. Otherwise `gh pr create --base <base> --title "<title>" --body-file <file>`. Report the URL and `gh pr checks` once.
- **`kind` gitlab, `cli` glab**: `git push -u <remote> HEAD`. If `glab mr view` finds a merge request for the branch, the push updated it. Otherwise `glab mr create --source-branch <branch> --target-branch <base> --title "<title>" --description "$(cat <file>)" --yes`. Report the URL and `glab ci status` once.
- **`kind` gitlab, no `cli`**: `git push -u <remote> HEAD -o merge_request.create -o merge_request.target=<base> -o "merge_request.title=<title>"`. GitLab prints the merge request URL in the push output; report it. Push options cannot carry the description: show the user the description so they can paste it.
- **Anything else**: `git push -u <remote> HEAD`, report the branch and show the user the description so they can open the request in the forge's web interface.

Never merge, and never ask the forge to merge automatically (no `gh pr merge --auto`, no `glab mr merge`, no auto-merge push option). Merging is the user's decision; in many projects a merge deploys.
```

- [ ] **Step 4: Rewrite `setup-project/SKILL.md` sections 1 and 2**

Section 1, third bullet:

```markdown
- `git fetch <remote>`, then create the branch from the remote's default branch, never from a stale local one: `git switch -c chore/claude-setup <remote>/<default>`. `node "${CLAUDE_SKILL_DIR}/../../scripts/forge.mjs"` prints the `remote` and the `defaultBranch`. If the checkout is on another branch, create a worktree instead of switching. If the repo has no remote or the default branch is `null`, ask. If the branch already exists, ask whether to reuse it.
```

Section 2, second and third bullets:

```markdown
- Read the CI configuration, whichever forge the repository uses: `.github/workflows/*.yml`, `.gitlab-ci.yml` and the local files it `include:`s, `azure-pipelines.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, `.circleci/config.yml`. Read `README.md` and build scripts (`build.ps1`, `Makefile`, `justfile`, `pyproject.toml`, `package.json`). The CI's commands are the source of truth for build, test and lint.
- Note what deploys or publishes and when: tags, pushes or merges to the default branch, deploy jobs and their environments, manual and scheduled pipeline jobs, container images that servers pull automatically. Note the production hosts, environments and package registries. These are the most important facts in the CLAUDE.md: the auto mode classifier reads it too and learns from it which targets are sensitive.
```

Section 6, last bullet:

```markdown
- Tell the user that `/flow:ship` opens the pull or merge request.
```

- [ ] **Step 5: Neutral `stacks.md` and `CLAUDE.template.md`**

In `stacks.md`, replace the table row `| \`ansible/\`, \`ansible.cfg\` | Ansible and infrastructure |` with `| \`ansible.cfg\`, \`*.tf\`, \`Chart.yaml\` | Infrastructure as code |`, add below the table's closing paragraph the line `Stacks this file does not cover: take build, test and lint commands from the CI and leave \`permissions.allow\` empty.`, and replace the section `## Ansible and infrastructure` with:

```markdown
## Infrastructure as code

- `check`: lint and validate only, as the CI does (for example `ansible-lint`, `terraform validate`, `helm lint`), with `"runIn": "linux"` for tools that live in WSL on Windows. Never apply, deploy or run a playbook against a host in the check.
- CLAUDE.md must name the environments and hosts that are production and state that applying changes, deploying and changing secrets need the user's explicit go.
```

In `CLAUDE.template.md`, replace the example of "Release and deploy":

```markdown
<What publishes or deploys, and when; the production hosts, environments and registries. Example: "Merging to the default branch deploys to production. Pushing a v* tag publishes the packages. Never tag without asking.">
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test plugins/flow/tests`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add plugins/flow/skills plugins/flow/tests/skills.test.mjs
git commit -m "feat(flow): ship and set up projects on GitHub, GitLab and other forges"
```

---

### Task 7: Documentation and cleanup

**Files:**
- Modify: `template/CLAUDE.md`, `README.md`, `CLAUDE.md`, `.claude-plugin/marketplace.json`, `plugins/flow/.claude-plugin/plugin.json`
- Delete: `docs/superpowers/2026-09-24-build-ledger.md`, `docs/superpowers/2026-09-25-generic-template-ledger.md`, `docs/superpowers/plans/2026-09-24-claude-setup.md`, `docs/superpowers/plans/2026-09-25-generic-template.md`, `docs/superpowers/specs/2026-09-24-claude-setup-design.md`, `docs/superpowers/specs/2026-09-25-generic-template-design.md`

- [ ] **Step 1: `template/CLAUDE.md`**

Git section, first bullet:

```markdown
- One branch per task (`feat/...`, `fix/...`, `chore/...`). Never commit or push to the repository's default branch (`main`, `master` or whatever it uses) directly; changes reach it through pull or merge requests the user merges.
```

Working style, the `/flow:ship` bullet and the CLI bullet:

```markdown
- When work is ready for a pull or merge request, point to `/flow:ship`. When you learned something about a project that belongs in its CLAUDE.md, suggest `/revise-claude-md`.
- Prefer CLIs over MCP servers: the forge's CLI (`gh` for GitHub, `glab` for GitLab) and `docker` for containers.
```

- [ ] **Step 2: Plugin descriptions**

In `.claude-plugin/marketplace.json` and `plugins/flow/.claude-plugin/plugin.json` the description stays; verify with `claude plugin validate plugins/flow`.

- [ ] **Step 3: README**

- Intro: "and ships finished work as a pull request" becomes "and ships finished work as a pull or merge request (GitHub, GitLab)".
- Layers table, Profile row: "Your own values: model, effort, extra plugins, your language and working rules". Machine row: "Generated on every install: OS, where Docker and Python run (host or WSL), Smart App Control, signed-in forge CLIs".
- Prerequisites table: replace the GitHub CLI row with `| GitHub CLI (\`gh\`) or GitLab CLI (\`glab\`), signed in | for \`/flow:ship\`; on GitLab optional | \`gh auth status\`, \`glab auth status\` |`.
- Step 3 table: `settings.json` row: "Only what differs from the template and holds on every machine you use: `model`, `effortLevel`, extra `enabledPlugins`. Permission lists add to the template's; other values replace it." Add below the table: "A profile holds lasting personal preferences only: no repository names, hosts, accounts, versions or temporary facts. Accounts and forges are detected on each machine; deploy targets and production hosts go into each project's `CLAUDE.md`, which `/flow:setup-project` writes." `CLAUDE.md` row: "The language Claude should chat in and your personal working rules."
- Step 6 checklist: first item becomes "The installer's output has a `Machine:`, a `Tools on the host:` and a `Forges:` line that describe this machine correctly."
- Section 3 step 2: "above all what deploys or publishes (merges to the default branch, tags, deploy jobs) and which hosts are production". Step 5: "Run `/flow:ship` to open the pull or merge request, then merge it."
- Section 4 step 4 Guards bullet: "pushes to the default branch (`main`, `master` or the repository's own), tag pushes, force pushes, auto-merges and merges ask you first".
- Section 4 step 5: item 5 becomes "Opens the pull request (GitHub) or merge request (GitLab; with `glab`, or through push options without it) with a summary, the verification evidence, the review results and your notes, and reports the CI status once. On other forges it pushes the branch and gives you the description."
- Section 4 step 6: "You read the pull or merge request".
- Guard table: first row "Push to the default branch (`main`, `master`, or the branch the remote's `HEAD` names), explicit or as current branch, tag push, force push, …". Second row: "`gh pr merge`, `gh release create/edit/delete`, `gh repo edit/rename/archive/delete`, `gh workflow run`, `glab mr merge`, `glab release create/update/upload/delete`, `glab repo update/transfer/delete`, `glab ci trigger/run`, `gh api`/`glab api` calls that merge or publish, push options `merge_request.merge_when_pipeline_succeeds`/`merge_request.auto_merge`". 
- Fork for a team: "To give the setup to a team (for example on a company GitLab), create the new repository from a single-commit snapshot of `main` without `profiles/<you>/` and without the dated documents in `docs/superpowers/`. Trusted infrastructure for the whole team belongs in managed settings (`autoMode.environment`)."
- Troubleshooting: add "- **`/flow:ship` does not find your forge CLI**: run `gh auth status` or `glab auth status --hostname <host>`; after signing in, run the installer again so `machine.md` lists it."

- [ ] **Step 4: Repo `CLAUDE.md`**

In Rules, replace the "Nothing personal" bullet:

```markdown
- Nothing personal outside `profiles/<name>/`: no user names, distros, versions, projects or hosts in `template/`, `plugins/`, `scripts/` or tests. Machine facts, forges and accounts come from `scripts/lib/machine.mjs`.
- Profiles hold lasting personal preferences only: no repository names, hosts, accounts, versions or temporary facts (pinned in `tests/layout.test.mjs`).
```

- [ ] **Step 5: Delete the dated documents of finished work**

```bash
git rm docs/superpowers/2026-09-24-build-ledger.md docs/superpowers/2026-09-25-generic-template-ledger.md docs/superpowers/plans/2026-09-24-claude-setup.md docs/superpowers/plans/2026-09-25-generic-template.md docs/superpowers/specs/2026-09-24-claude-setup-design.md docs/superpowers/specs/2026-09-25-generic-template-design.md
```

- [ ] **Step 6: Verify**

Run: `node --test` (exit code 0), `claude plugin validate plugins/flow`, and `git grep -n -i -E "<owner's GitHub name>|<private project names>|<private hosts>" -- . ':!profiles'` with the owner's identifiers typed in the shell only (expected: no matches).

- [ ] **Step 7: Commit**

```bash
git add -A template/CLAUDE.md README.md CLAUDE.md docs
git commit -m "docs: describe the forge-neutral setup and drop finished dated documents"
```
