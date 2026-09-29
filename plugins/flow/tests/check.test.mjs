import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_FILE, changedPaths, commandSpec, evaluateStop, loadFlowConfig, matchesCheckOn, readMachine, runCheck, tail } from "../scripts/lib/check.mjs";
import { removeDir, tempRepo } from "./helpers.mjs";

const flow = (check, checkOn = [".cs"]) => JSON.stringify({ check, checkOn });
const green = () => ({ ok: true, timedOut: false, status: 0, output: "" });
const red = () => ({ ok: false, timedOut: false, status: 1, output: "error CS1002: ; expected" });

function spy(result = green) {
  const calls = [];
  return { calls, run: (root, config) => { calls.push(config.check); return result(); } };
}

function repoWithFlow(t, config = flow("build"), options = {}) {
  const repo = tempRepo(options);
  t.after(repo.cleanup);
  if (config) {
    repo.write(".claude/flow.json", config);
    repo.git("add", ".");
    repo.git("commit", "-q", "-m", "flow");
  }
  return repo;
}

test("changedPaths reads porcelain -z output including renames", () => {
  assert.deepEqual(
    changedPaths(" M src/a.cs\0R  new.cs\0old.cs\0C  copy.cs\0orig.cs\0?? dir/b.cs\0"),
    ["src/a.cs", "new.cs", "old.cs", "copy.cs", "dir/b.cs"],
  );
});

test("matchesCheckOn compares suffixes case-insensitively and an empty list matches everything", () => {
  assert.equal(matchesCheckOn("src/A.CS", [".cs"]), true);
  assert.equal(matchesCheckOn("notes.md", [".cs"]), false);
  assert.equal(matchesCheckOn("notes.md", []), true);
});

test("tail keeps the last lines", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n");
  const out = tail(text, 60);
  assert.equal(out.split("\n").length, 60);
  assert.match(out, /^line 40\n/);
  assert.match(out, /line 99$/);
});

test("outside a git repository Claude may stop", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-nogit-"));
  t.after(() => removeDir(dir));
  const s = spy();
  assert.equal(await evaluateStop({ cwd: dir }, { run: s.run }), null);
  assert.equal(s.calls.length, 0);
});

test("without flow.json nothing runs", async (t) => {
  const repo = repoWithFlow(t, null);
  repo.write("a.cs", "class A {}");
  const s = spy();
  assert.equal(await evaluateStop({ cwd: repo.dir }, { run: s.run }), null);
  assert.equal(s.calls.length, 0);
});

test("without relevant changes nothing runs", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("notes.md", "text");
  const s = spy();
  assert.equal(await evaluateStop({ cwd: repo.dir }, { run: s.run }), null);
  assert.equal(s.calls.length, 0);
});

test("a failing check blocks with the command's exit code and output", async (t) => {
  const repo = repoWithFlow(t, flow(`node -e "console.log('boom-marker'); process.exit(3)"`));
  repo.write("src/a.cs", "class A {}");
  const out = JSON.parse(await evaluateStop({ cwd: repo.dir }));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /exited with code 3/);
  assert.match(out.reason, /boom-marker/);
});

test("a passing check is remembered and not re-run for the same state", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("src/a.cs", "class A {}");
  const s = spy();
  assert.equal(await evaluateStop({ cwd: repo.dir }, { run: s.run }), null);
  assert.equal(await evaluateStop({ cwd: repo.dir }, { run: s.run }), null);
  assert.equal(s.calls.length, 1);
  assert.ok(fs.existsSync(path.join(repo.dir, STATE_FILE)));
});

test("changing a relevant file again re-runs the check", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("src/a.cs", "class A {}");
  const s = spy();
  await evaluateStop({ cwd: repo.dir }, { run: s.run });
  repo.write("src/a.cs", "class A { int x; }");
  await evaluateStop({ cwd: repo.dir }, { run: s.run });
  assert.equal(s.calls.length, 2);
});

test("an unchanged failure blocks once, then lets Claude stop", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("src/a.cs", "broken");
  const s = spy(red);
  const first = JSON.parse(await evaluateStop({ cwd: repo.dir, stop_hook_active: false }, { run: s.run }));
  assert.equal(first.decision, "block");
  assert.match(first.reason, /CS1002/);
  assert.equal(await evaluateStop({ cwd: repo.dir, stop_hook_active: true }, { run: s.run }), null);
  assert.equal(s.calls.length, 1);
});

test("an unchanged failure does not block again on a new turn and is not re-run", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("src/a.cs", "broken");
  const s = spy(red);
  const first = JSON.parse(await evaluateStop({ cwd: repo.dir, stop_hook_active: false }, { run: s.run }));
  assert.equal(first.decision, "block");
  assert.equal(await evaluateStop({ cwd: repo.dir, stop_hook_active: false }, { run: s.run }), null);
  assert.equal(s.calls.length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(repo.dir, STATE_FILE), "utf8"));
  assert.equal("lastFailedReason" in state, false);
});

test("a changed red state blocks again", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("src/a.cs", "broken");
  const s = spy(red);
  await evaluateStop({ cwd: repo.dir, stop_hook_active: false }, { run: s.run });
  repo.write("src/a.cs", "still broken");
  const again = JSON.parse(await evaluateStop({ cwd: repo.dir, stop_hook_active: true }, { run: s.run }));
  assert.equal(again.decision, "block");
  assert.equal(s.calls.length, 2);
});

test("changing the check in flow.json re-runs it for the same files", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("src/a.cs", "class A {}");
  const s = spy();
  assert.equal(await evaluateStop({ cwd: repo.dir }, { run: s.run }), null);
  repo.write(".claude/flow.json", flow("build --strict"));
  assert.equal(await evaluateStop({ cwd: repo.dir }, { run: s.run }), null);
  assert.deepEqual(s.calls, ["build", "build --strict"]);
});

test("a timeout is reported as such", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("src/a.cs", "class A {}");
  const s = spy(() => ({ ok: false, timedOut: true, status: null, output: "" }));
  const out = JSON.parse(await evaluateStop({ cwd: repo.dir }, { run: s.run }));
  assert.match(out.reason, /timed out after 300s/);
});

test("the state file never triggers the check", async (t) => {
  const repo = repoWithFlow(t, flow("build", []));
  repo.write("src/a.cs", "class A {}");
  const s = spy();
  await evaluateStop({ cwd: repo.dir }, { run: s.run });
  await evaluateStop({ cwd: repo.dir }, { run: s.run });
  assert.equal(s.calls.length, 1);
});

test("a repository without commits still works", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-empty-"));
  t.after(() => removeDir(dir));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "flow.json"), flow("build"));
  fs.writeFileSync(path.join(dir, "a.cs"), "class A {}");
  const s = spy();
  assert.equal(await evaluateStop({ cwd: dir }, { run: s.run }), null);
  assert.equal(s.calls.length, 1);
});

test("a repository path with spaces works end to end", async (t) => {
  const repo = repoWithFlow(t, flow(`node -e "process.exit(1)"`), { name: "flow test " });
  repo.write("src/a.cs", "class A {}");
  assert.equal(JSON.parse(await evaluateStop({ cwd: path.join(repo.dir, "src") })).decision, "block");
});

test("a grandchild that keeps the pipes open does not hang the check", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-grandchild-"));
  try {
    const check =
      "node -e \"require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'inherit'}); process.exit(0)\"";
    const started = Date.now();
    const result = await runCheck(root, { check, checkOn: [], timeoutSec: 300 });
    assert.ok(Date.now() - started < 10000, "runCheck should not wait on the grandchild's inherited pipes");
    assert.equal(result.ok, true);
  } finally {
    removeDir(root);
  }
});

test("a hanging check is killed after timeoutSec", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-hang-"));
  try {
    const check = 'node -e "setTimeout(()=>{},60000)"';
    const started = Date.now();
    const result = await runCheck(root, { check, checkOn: [], timeoutSec: 1 });
    assert.ok(Date.now() - started < 10000, "runCheck should kill the hung check well before 10s");
    assert.equal(result.timedOut, true);
  } finally {
    removeDir(root);
  }
});

test("the check runs with MSBuild node reuse disabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-msbuild-env-"));
  try {
    const check = 'node -e "process.exit(process.env.MSBUILDDISABLENODEREUSE===\'1\'?0:1)"';
    const result = await runCheck(root, { check, checkOn: [], timeoutSec: 300 });
    assert.equal(result.ok, true);
  } finally {
    removeDir(root);
  }
});

test("renaming a file away from a checkOn suffix still runs the check", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("src/Foo.cs", "class Foo {}");
  repo.git("add", ".");
  repo.git("commit", "-q", "-m", "foo");
  repo.git("mv", "src/Foo.cs", "src/Foo.txt");
  const check = spy(red);
  const out = await evaluateStop({ cwd: repo.dir }, { run: check.run });
  assert.equal(check.calls.length, 1);
  assert.match(JSON.parse(out).reason, /flow check failed/);
});

test("a check killed from outside is reported as terminated, not as code null", async (t) => {
  const repo = repoWithFlow(t);
  repo.write("a.cs", "x");
  const killed = () => ({ ok: false, timedOut: false, status: null, signal: "SIGTERM", output: "" });
  const out = JSON.parse(await evaluateStop({ cwd: repo.dir }, { run: spy(killed).run }));
  assert.match(out.reason, /was terminated \(SIGTERM\)/);
  assert.doesNotMatch(out.reason, /code null/);
});

test("runCheck resolves after a grace period even when killing the tree fails", async () => {
  const started = Date.now();
  const result = await runCheck(
    os.tmpdir(),
    { check: `node -e "setTimeout(() => {}, 4000)"`, timeoutSec: 0.2 },
    { killTree: () => {}, graceMs: 300 },
  );
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3000, "resolved before the child ended on its own");
});

const WSL_MACHINE = { os: "windows", wsl: { distro: "Dev" } };

test("runIn linux runs in the WSL distro on Windows, without a shell", () => {
  assert.deepEqual(
    commandSpec("uv run pytest", { runIn: "linux", root: "C:\\My Repos\\app", machine: WSL_MACHINE, platform: "win32" }),
    { file: "wsl.exe", args: ["-d", "Dev", "--cd", "C:\\My Repos\\app", "--exec", "bash", "-lc", "uv run pytest"], shell: false },
  );
});

test("runIn linux runs on the host on macOS, without a distro, or without machine facts", () => {
  const host = { file: "uv run pytest", args: [], shell: true };
  assert.deepEqual(commandSpec("uv run pytest", { runIn: "linux", root: "/r", machine: WSL_MACHINE, platform: "darwin" }), host);
  assert.deepEqual(commandSpec("uv run pytest", { runIn: "linux", root: "C:\\r", machine: { os: "windows" }, platform: "win32" }), host);
  assert.deepEqual(commandSpec("uv run pytest", { runIn: "linux", root: "C:\\r", machine: null, platform: "win32" }), host);
  assert.deepEqual(commandSpec("dotnet build", { runIn: null, root: "C:\\r", machine: WSL_MACHINE, platform: "win32" }), { file: "dotnet build", args: [], shell: true });
});

test("a missing or corrupt machine.json reads as null", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-machine-"));
  t.after(() => removeDir(dir));
  assert.equal(readMachine(path.join(dir, "none.json")), null);
  fs.writeFileSync(path.join(dir, "bad.json"), "{broken");
  assert.equal(readMachine(path.join(dir, "bad.json")), null);
});

test("flow.json runIn and test are read, unknown runIn values are ignored", (t) => {
  const repo = repoWithFlow(t, JSON.stringify({ check: "c", test: "t", runIn: "linux" }));
  assert.deepEqual({ ...loadFlowConfig(repo.dir), checkOn: undefined, timeoutSec: undefined }, { check: "c", test: "t", runIn: "linux", checkOn: undefined, timeoutSec: undefined });
  const other = repoWithFlow(t, JSON.stringify({ check: "c", runIn: "mars" }));
  assert.equal(loadFlowConfig(other.dir).runIn, null);
});

test("a runIn linux check really runs in WSL", { skip: !(process.platform === "win32" && readMachine()?.wsl) && "needs WSL" }, async () => {
  // A directory nobody deletes: WSL keeps the working directory open for a while after the command.
  const result = await runCheck(os.tmpdir(), { check: "pwd", runIn: "linux", timeoutSec: 60 });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /^\/mnt\/[a-z]\//m);
});

test("a timed-out runIn linux check leaves no process behind in WSL", { skip: !(process.platform === "win32" && readMachine()?.wsl) && "needs WSL" }, async (t) => {
  const wsl = (...args) => spawnSync("wsl.exe", ["-d", readMachine().wsl.distro, "--exec", ...args], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  t.after(() => wsl("pkill", "-f", "sleep 4711"));
  assert.equal(wsl("true").status, 0, "start the distro first, so the time limit is spent on the check");
  const result = await runCheck(os.tmpdir(), { check: "echo started; sleep 4711 & sleep 4711; wait", runIn: "linux", timeoutSec: 3 });
  assert.equal(result.timedOut, true);
  assert.match(result.output, /started/);
  let status = 0; // pgrep: 0 = found, 1 = none, anything else = pgrep or WSL failed
  for (let i = 0; i < 20 && status === 0; i++) {
    status = wsl("pgrep", "-f", "sleep 4711").status;
    if (status === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(status, 1, "sleep 4711 still runs in WSL, or pgrep could not run");
});

test("on macOS and Linux a timed-out check kills its whole process group", { skip: process.platform === "win32" && "POSIX only" }, async () => {
  const started = Date.now();
  const result = await runCheck(os.tmpdir(), { check: "sleep 30 & sleep 30; wait", timeoutSec: 0.5 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000);
});
