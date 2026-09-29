#!/usr/bin/env node
// PreToolUse hook: asks the user before Claude pushes to the default branch (or main/master), pushes
// tags, force-pushes, requests an auto-merge, merges a pull or merge request, starts a
// deploy-capable pipeline or publishes a release. Every other command passes untouched.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { preToolUseDecision, runHook } from "./lib/hook-io.mjs";
import { assessCommand, nativeDir } from "./lib/push-rules.mjs";

// Git Bash's own mapping for POSIX paths like /tmp; null when cygpath is not available.
function cygpath(dir) {
  const result = spawnSync("cygpath", ["-w", dir], { encoding: "utf8", timeout: 2000, windowsHide: true });
  const mapped = result.status === 0 ? result.stdout.trim() : "";
  return mapped || null;
}

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

await runHook(async (input) => {
  const command = input.tool_input?.command;
  if (typeof command !== "string") return null;
  const cwd = input.cwd ?? process.cwd();
  const reason = assessCommand(command, {
    branchOf: branchResolver(cwd),
    defaultBranchOf: defaultBranchResolver(cwd),
    shell: input.tool_name === "PowerShell" ? "powershell" : "bash",
  });
  return reason ? preToolUseDecision("ask", `flow: ${reason}. Approve only if you intend exactly this.`) : null;
});
