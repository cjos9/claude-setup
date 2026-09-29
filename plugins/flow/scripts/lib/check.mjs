// Stop-hook logic: run the project's check when relevant code changed since the last verified state.
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export const STATE_FILE = ".claude/.flow-state.json";
export const MACHINE_FILE = path.join(os.homedir(), ".claude", "claude-setup", "machine.json");

// Facts the installer detected about this machine; null before the first install.
export function readMachine(file = process.env.FLOW_MACHINE_JSON ?? MACHINE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// How to start a flow.json command: through the host shell, or in WSL when runIn is "linux" and
// this Windows machine keeps its Linux tools there. WSL gets the command as one argument (no shell
// in between), so nothing on the Windows side expands $PATH or quotes.
export function commandSpec(command, { runIn, root, machine, platform = process.platform }) {
  const distro = machine?.wsl?.distro;
  if (runIn === "linux" && platform === "win32" && distro) {
    return { file: "wsl.exe", args: ["-d", distro, "--cd", root, "--exec", "bash", "-lc", command], shell: false };
  }
  return { file: command, args: [], shell: true };
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function repoRoot(cwd) {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return null;
  }
}

export function loadFlowConfig(root) {
  const file = path.join(root, ".claude", "flow.json");
  if (!fs.existsSync(file)) return null;
  const config = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  if (typeof config.check !== "string" || config.check.trim() === "") return null;
  return {
    check: config.check,
    checkOn: Array.isArray(config.checkOn) ? config.checkOn : [],
    test: typeof config.test === "string" && config.test.trim() !== "" ? config.test : null,
    runIn: config.runIn === "linux" ? "linux" : null,
    timeoutSec: Number(config.timeoutSec) > 0 ? Number(config.timeoutSec) : 300,
  };
}

// Paths from `git status --porcelain=v1 -z`; renames and copies carry their old path as an extra entry.
// A rename's old path counts as changed (Foo.cs -> Foo.txt removes a .cs file); a copy's does not.
export function changedPaths(porcelainZ) {
  const entries = porcelainZ.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    paths.push(entries[i].slice(3));
    if (status.includes("R")) paths.push(entries[++i]);
    else if (status.includes("C")) i++;
  }
  return paths;
}

export function matchesCheckOn(file, checkOn) {
  if (checkOn.length === 0) return true;
  const lower = file.toLowerCase();
  return checkOn.some((suffix) => lower.endsWith(String(suffix).toLowerCase()));
}

// Where the branch's work starts: the merge base with origin's default branch as the clone knows it
// (origin/HEAD, else origin/main or origin/master), and only without those with a local main or
// master, which may be stale. null without one (for example before the first commit).
export function workBase(root) {
  const refs = ["refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"];
  try {
    refs.unshift(git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim());
  } catch {
    // No remote named origin, or it has no HEAD.
  }
  for (const ref of refs) {
    try {
      return git(root, ["merge-base", "HEAD", ref]).trim();
    } catch {
      // The ref does not exist or shares no history with HEAD.
    }
  }
  return null;
}

// Uncommitted files plus the files the branch's commits changed; a rename counts as both paths.
export function relevantChanges(root, checkOn) {
  const paths = changedPaths(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const base = workBase(root);
  if (base) paths.push(...git(root, ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"]).split("\0").filter(Boolean));
  return [...new Set(paths)].filter((file) => file !== STATE_FILE && matchesCheckOn(file, checkOn));
}

// Hashes the check configuration, HEAD and the content of every relevant changed file, so untracked
// files count too and a changed check invalidates an old result.
export function fingerprint(root, files, config = {}) {
  const hash = createHash("sha256");
  let head = "no-commits";
  try {
    head = git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    // A fresh repository has no HEAD yet.
  }
  hash.update(JSON.stringify({ check: config.check, checkOn: config.checkOn, runIn: config.runIn, timeoutSec: config.timeoutSec }));
  hash.update(`\0${head}`);
  for (const file of [...files].sort()) {
    const absolute = path.join(root, file);
    hash.update(`\0${file}\0`);
    hash.update(fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? fs.readFileSync(absolute) : "<deleted>");
  }
  return hash.digest("hex");
}

export function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), "utf8"));
  } catch {
    return {};
  }
}

export function writeState(root, state) {
  const file = path.join(root, STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function tail(text, lines = 60) {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

// Kills the whole process tree: killing just the shell leaves a hung grandchild running. On POSIX
// the check runs in its own process group, so the negative pid reaches every member.
function killTreeOf(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

// Runs the check asynchronously so a hung grandchild (e.g. an MSBuild/Roslyn server left behind
// by `dotnet build`) that keeps our stdout/stderr pipes open cannot wedge the hook: we resolve on
// the immediate child's `exit` event, never on `close`, which would wait for those pipes to EOF.
export function runCheck(root, config, { killTree = killTreeOf, graceMs = 5000, machine = readMachine() } = {}) {
  return new Promise((resolve) => {
    let output = Buffer.alloc(0);
    const collect = (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_OUTPUT_BYTES) output = output.subarray(output.length - MAX_OUTPUT_BYTES);
    };

    const spec = commandSpec(config.check, { runIn: config.runIn, root, machine });
    const child = spawn(spec.file, spec.args, {
      cwd: root,
      shell: spec.shell,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, MSBUILDDISABLENODEREUSE: "1", DOTNET_CLI_USE_MSBUILD_SERVER: "0" },
    });
    child.stdin?.end();
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve(result);
    };

    let grace;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // If the kill fails, the exit event may never come: give up after a grace period.
      grace = setTimeout(() => {
        finish({ ok: false, timedOut: true, status: null, output: output.toString("utf8") });
      }, graceMs);
    }, config.timeoutSec * 1000);

    child.on("error", (error) => {
      finish({ ok: false, timedOut: false, status: null, output: String(error?.message ?? error) });
    });

    child.on("exit", (code, signal) => {
      finish({
        ok: !timedOut && code === 0,
        timedOut,
        status: timedOut ? null : code,
        signal,
        output: output.toString("utf8"),
      });
    });
  });
}

function block(reason) {
  return JSON.stringify({ decision: "block", reason });
}

// Returns the Stop-hook JSON to print, or null to let Claude stop.
export async function evaluateStop(input, { run = runCheck } = {}) {
  const root = repoRoot(input.cwd ?? process.cwd());
  if (!root) return null;
  const config = loadFlowConfig(root);
  if (!config) return null;
  const files = relevantChanges(root, config.checkOn);
  if (files.length === 0) return null;

  const print = fingerprint(root, files, config);
  const state = readState(root);
  if (state.lastGreen === print) return null;
  // Claude already got this failure and changed nothing since: it may stop, on this turn or any later one.
  if (state.lastFailed === print) return null;

  const result = await run(root, config);
  if (result.ok) {
    writeState(root, { lastGreen: print });
    return null;
  }
  const why = result.timedOut
    ? `timed out after ${config.timeoutSec}s`
    : result.status === null
      ? `was terminated (${result.signal ?? "no exit code"})`
      : `exited with code ${result.status}`;
  const reason = [
    `flow check failed: \`${config.check}\` ${why}.`,
    "Fix it before you finish. If the failure is unrelated to your change, say so explicitly.",
    "",
    tail(result.output),
  ].join("\n");
  writeState(root, { lastGreen: state.lastGreen, lastFailed: print });
  return block(reason);
}
