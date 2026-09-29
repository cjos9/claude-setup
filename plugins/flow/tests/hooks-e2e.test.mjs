import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScript, tempRepo } from "./helpers.mjs";

const decision = (stdout) => JSON.parse(stdout).hookSpecificOutput.permissionDecision;

test("guard-push asks before a plain push from main", (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const result = runScript("guard-push.mjs", { tool_name: "Bash", tool_input: { command: "git push" }, cwd: repo.dir });
  assert.equal(result.status, 0);
  assert.equal(decision(result.stdout), "ask");
});

test("guard-push stays silent on a feature branch", (t) => {
  const repo = tempRepo({ branch: "feat/x" });
  t.after(repo.cleanup);
  const result = runScript("guard-push.mjs", { tool_name: "Bash", tool_input: { command: "git push -u origin HEAD" }, cwd: repo.dir });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("guard-push resolves git -C with a quoted Windows path", (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const command = `git -C "${repo.dir}" push`;
  const result = runScript("guard-push.mjs", { tool_name: "PowerShell", tool_input: { command }, cwd: os.tmpdir() });
  assert.equal(decision(result.stdout), "ask");
});

const reasonOf = (stdout) => JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason;
// C:\Users\me\repo -> /c/Users/me/repo, the form Git Bash uses.
const msysPath = (dir) => dir.replace(/^([A-Za-z]):[\\/]*/, (_, drive) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/");
const guard = (command, cwd, tool = "Bash") => runScript("guard-push.mjs", { tool_name: tool, tool_input: { command }, cwd });

test("guard-push asks before a push from the remote's default branch, whatever its name", (t) => {
  const repo = tempRepo({ branch: "develop" });
  t.after(repo.cleanup);
  assert.equal(guard("git push", repo.dir).stdout, "", "without a known default branch develop is a feature branch");
  repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  const result = guard("git push", repo.dir);
  assert.equal(decision(result.stdout), "ask");
  assert.match(reasonOf(result.stdout), /develop/);
});

test("guard-push follows Git Bash paths to a repository on main", { skip: process.platform !== "win32" }, (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const dir = msysPath(repo.dir);
  for (const command of [
    `cd "${dir}" && git push`,
    `git -C "${dir}" push`,
    `cd "${dir}" && git status && git push origin HEAD`,
  ]) {
    const result = guard(command, os.tmpdir());
    assert.equal(decision(result.stdout), "ask", command);
    assert.match(reasonOf(result.stdout), /main/, command);
  }
});

test("guard-push composes successive cd targets", (t) => {
  const main = tempRepo();
  const feature = tempRepo({ branch: "feat/x" });
  t.after(main.cleanup);
  t.after(feature.cleanup);
  const hop = (repo) => `cd "${path.dirname(repo.dir)}" && cd ${path.basename(repo.dir)} && git push`;
  assert.equal(guard(hop(feature), main.dir).stdout, "");
  const toMain = guard(hop(main), feature.dir);
  assert.equal(decision(toMain.stdout), "ask");
  assert.match(reasonOf(toMain.stdout), /publishes directly to main/);
});

test("guard-push follows Push-Location", (t) => {
  const main = tempRepo();
  const feature = tempRepo({ branch: "feat/x" });
  t.after(main.cleanup);
  t.after(feature.cleanup);
  assert.match(reasonOf(guard(`Push-Location "${main.dir}"; git push`, feature.dir, "PowerShell").stdout), /main/);
  assert.equal(guard(`Push-Location "${feature.dir}"; git push`, main.dir, "PowerShell").stdout, "");
});

test("guard-push asks when the branch cannot be determined", (t) => {
  const feature = tempRepo({ branch: "feat/x" });
  t.after(feature.cleanup);
  const missing = path.join(feature.dir, "does-not-exist");
  const result = guard(`cd "${missing}" && git push`, feature.dir);
  assert.equal(decision(result.stdout), "ask");
  assert.match(reasonOf(result.stdout), /could not be determined/);
});

test("protect-files denies reading .env and allows ordinary files", () => {
  const denied = runScript("protect-files.mjs", { tool_name: "Read", tool_input: { file_path: "C:\\repo\\.env" } });
  assert.equal(decision(denied.stdout), "deny");
  const allowed = runScript("protect-files.mjs", { tool_name: "Edit", tool_input: { file_path: "C:\\repo\\src\\a.cs" } });
  assert.equal(allowed.stdout, "");
});

test("check-on-stop blocks on a failing check", (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  repo.write(".claude/flow.json", JSON.stringify({ check: `node -e "process.exit(2)"`, checkOn: [".cs"] }));
  repo.write("a.cs", "class A {}");
  const result = runScript("check-on-stop.mjs", { hook_event_name: "Stop", cwd: repo.dir, stop_hook_active: false });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

test("malformed input never blocks", () => {
  for (const script of ["guard-push.mjs", "protect-files.mjs", "check-on-stop.mjs", "notify.mjs"]) {
    for (const input of ["not json", "", "{}"]) {
      const result = runScript(script, input);
      assert.equal(result.status, 0, `${script} with ${JSON.stringify(input)}`);
      assert.equal(result.stdout, "", `${script} with ${JSON.stringify(input)}`);
    }
  }
});

test("hooks.json registers every script in exec form", () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "hooks.json");
  const { hooks } = JSON.parse(fs.readFileSync(file, "utf8"));
  const commands = Object.values(hooks).flat().flatMap((group) => group.hooks);
  const scripts = commands.map((hook) => hook.args[0].replace("${CLAUDE_PLUGIN_ROOT}/scripts/", ""));
  assert.deepEqual(scripts.sort(), ["check-on-stop.mjs", "guard-push.mjs", "notify.mjs", "protect-files.mjs"]);
  for (const hook of commands) assert.equal(hook.command, "node");
});
