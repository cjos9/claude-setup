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

test("a host with a neutral name is the forge whose CLI is signed in there", () => {
  const base = {
    "git -C /r rev-parse --show-toplevel": { stdout: "/r\n" },
    "git -C /r remote get-url origin": { stdout: "git@code.example.com:team/app.git\n" },
    "git -C /r remote": { stdout: "origin\n" },
  };
  const gitlab = describeRepo("/r", {
    run: fakeRun({ ...base, "glab auth status --hostname code.example.com": { stderr: "  ✓ Logged in to code.example.com as jdoe (c)\n" } }),
    exists: () => false,
  });
  assert.equal(gitlab.kind, "gitlab");
  assert.equal(gitlab.cli, "glab");
  const github = describeRepo("/r", {
    run: fakeRun({ ...base, "gh auth status --hostname code.example.com": { stdout: "  ✓ Logged in to code.example.com account octo (keyring)\n" } }),
    exists: () => false,
  });
  assert.equal(github.kind, "github");
  assert.equal(github.cli, "gh");
  const neither = describeRepo("/r", { run: fakeRun(base), exists: () => false });
  assert.equal(neither.kind, "unknown");
  assert.equal(neither.cli, null);
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
