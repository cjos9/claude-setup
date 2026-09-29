import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { weekdayClock } from "../template/statusline.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "template", "statusline.mjs");

test("the weekday of the 7-day reset follows the locale", () => {
  const monday = new Date(2026, 8, 28, 9, 5);
  assert.equal(weekdayClock(monday, "en-US"), "Mon 09:05");
  assert.equal(weekdayClock(monday, "de-DE"), "Mo 09:05");
});

test("run as a script, it prints the status line", () => {
  const input = JSON.stringify({ model: { display_name: "Opus" }, rate_limits: { seven_day: { used_percentage: 10, resets_at: 1790000000 } } });
  const result = spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Opus/);
  assert.match(result.stdout, /7d .*10%/);
});
