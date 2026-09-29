import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { SCRIPTS, tempRepo } from "./helpers.mjs";

const runFlow = (cwd, which) => spawnSync(process.execPath, [path.join(SCRIPTS, "run-flow.mjs"), which], { cwd, encoding: "utf8" });

test("run-flow runs the configured command and passes its exit code on", (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  repo.write(".claude/flow.json", JSON.stringify({ check: 'node -e "process.exit(3)"', test: 'node -e "console.log(42)"' }));
  assert.equal(runFlow(repo.dir, "check").status, 3);
  const test = runFlow(repo.dir, "test");
  assert.equal(test.status, 0);
  assert.match(test.stdout, /42/);
});

test("run-flow explains a missing command and bad arguments", (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  repo.write(".claude/flow.json", JSON.stringify({ check: "node -v" }));
  const missing = runFlow(repo.dir, "test");
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no "test" in \.claude\/flow\.json/);
  assert.equal(runFlow(repo.dir, "deploy").status, 2);
});
