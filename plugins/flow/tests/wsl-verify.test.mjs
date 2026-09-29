import test from "node:test";
import assert from "node:assert/strict";
import { toWslPath, isSafeMirrorSource } from "../skills/wsl/wsl-verify.mjs";
import { readMachine } from "../scripts/lib/check.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

test("drive paths map to /mnt/<drive>", () => {
  assert.equal(toWslPath("C:\\Users\\me\\dev\\app"), "/mnt/c/Users/me/dev/app");
  assert.equal(toWslPath("D:/work/my repo/"), "/mnt/d/work/my repo");
  assert.equal(toWslPath("C:\\"), "/mnt/c");
});

test("non-drive paths are rejected", () => {
  assert.throws(() => toWslPath("/home/me/x"), /Not a Windows drive path/);
});

test("isSafeMirrorSource accepts valid /mnt paths", () => {
  assert.equal(isSafeMirrorSource("/mnt/c/Users/me/dev"), true);
  assert.equal(isSafeMirrorSource("/mnt/d/work/repo"), true);
});

test("isSafeMirrorSource rejects empty and invalid paths", () => {
  assert.equal(isSafeMirrorSource(""), false);
  assert.equal(isSafeMirrorSource("/"), false);
  assert.equal(isSafeMirrorSource("/mnt"), false);
  assert.equal(isSafeMirrorSource("/mnt/c"), false);
  assert.equal(isSafeMirrorSource("/mnt/z"), false);
  assert.equal(isSafeMirrorSource("/home/me"), false);
});

test("isSafeMirrorSource rejects drive roots with trailing slashes", () => {
  assert.equal(isSafeMirrorSource("/mnt/c/"), false);
  assert.equal(isSafeMirrorSource("/mnt/c//"), false);
});

test("isSafeMirrorSource rejects paths with .. segments", () => {
  assert.equal(isSafeMirrorSource("/mnt/../etc"), false);
  assert.equal(isSafeMirrorSource("/mnt/c/../.."), false);
  assert.equal(isSafeMirrorSource("/mnt/c/Users/../.."), false);
});

test("isSafeMirrorSource accepts valid paths including trailing slashes", () => {
  assert.equal(isSafeMirrorSource("/mnt/c/Users/me/dev"), true);
  assert.equal(isSafeMirrorSource("/mnt/d/work/my repo"), true);
  assert.equal(isSafeMirrorSource("/mnt/c/Users/me/dev/"), true);
  assert.equal(isSafeMirrorSource("/mnt/d/work/my repo/"), true);
  assert.equal(isSafeMirrorSource("/mnt/c/Users/me/dev//"), true);
});

test("isSafeMirrorSource accepts filenames with .. as substring", () => {
  assert.equal(isSafeMirrorSource("/mnt/c/Users/me/dev/..foo"), true);
  assert.equal(isSafeMirrorSource("/mnt/c/Users/me/dev/foo..bar"), true);
  assert.equal(isSafeMirrorSource("/mnt/c/Users/me/dev/foo...bar"), true);
});

test("running outside a git repository returns exit code 2", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "wsl-test-"));
  try {
    const scriptPath = path.resolve("plugins/flow/skills/wsl/wsl-verify.mjs");
    const result = spawnSync("node", [scriptPath, "echo", "x"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: tempDir },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /run this from inside a git repository/);
  } finally {
    rmSync(tempDir, { recursive: true });
  }
});

const DISTRO = process.env.FLOW_WSL_DISTRO ?? readMachine()?.wsl?.distro;
const hasWsl =
  process.platform === "win32" && Boolean(DISTRO) && spawnSync("wsl", ["-d", DISTRO, "--", "true"], { windowsHide: true }).status === 0;
// Only computed when WSL runs the script: on macOS the path is not a Windows drive path.
function runScript(...args) {
  const scriptInWsl = toWslPath(path.join(import.meta.dirname, "..", "skills", "wsl", "wsl-verify.sh"));
  return spawnSync("wsl", ["-d", DISTRO, "--", "bash", scriptInWsl, ...args], { encoding: "utf8", windowsHide: true });
}

test("the bash guard refuses to mirror unsafe sources", { skip: !hasWsl && "needs WSL" }, () => {
  for (const [source, message] of [
    ["/etc", /must be in \/mnt/],
    ["/mnt/c", /drive root/],
    ["/mnt/c/x/../y", /\.\. segments/],
  ]) {
    const result = runScript(source, "true");
    assert.notEqual(result.status, 0, source);
    assert.match(result.stderr, message, source);
  }
});

test("mirrors of same-named folders from different paths do not collide", { skip: !hasWsl && "needs WSL" }, () => {
  const roots = [mkdtempSync(path.join(os.tmpdir(), "flow-a-")), mkdtempSync(path.join(os.tmpdir(), "flow-b-"))];
  const mirrors = [];
  try {
    for (const root of roots) {
      const repo = path.join(root, "same-name");
      spawnSync("git", ["init", "-q", repo]);
      const result = runScript(toWslPath(repo), "pwd");
      assert.equal(result.status, 0, result.stderr);
      mirrors.push(result.stdout.trim().split("\n").pop());
    }
    assert.match(mirrors[0], /\/verify\/same-name-[0-9a-f]{8}$/);
    assert.notEqual(mirrors[0], mirrors[1]);
  } finally {
    for (const mirror of mirrors) spawnSync("wsl", ["-d", DISTRO, "--", "rm", "-rf", mirror]);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("without a detected distro wsl-verify says how to fix it", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wsl-verify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", dir]);
  const script = path.join(import.meta.dirname, "..", "skills", "wsl", "wsl-verify.mjs");
  const env = { ...process.env, FLOW_MACHINE_JSON: path.join(dir, "missing.json") };
  delete env.FLOW_WSL_DISTRO;
  const result = spawnSync(process.execPath, [script, "true"], { cwd: dir, encoding: "utf8", env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No WSL distro with Docker or Python was detected/);
});

test("the wsl skill's commands are valid and it says what to do without machine facts", () => {
  const skill = readFileSync(path.join(import.meta.dirname, "..", "skills", "wsl", "SKILL.md"), "utf8");
  // wsl --cd needs an absolute Windows path; "--cd ." fails with Wsl/E_INVALIDARG.
  assert.doesNotMatch(skill, /--cd \./);
  assert.match(skill, /missing or names no distro, run the claude-setup installer/);
});
