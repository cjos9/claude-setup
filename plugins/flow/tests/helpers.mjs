// Test helpers: throwaway git repositories and running hook scripts the way Claude Code does.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

// Windows can hold a folder for a moment after a process in it was killed, so removal retries.
export const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

export function tempRepo({ branch = "main", name = "flow-test-" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (file, content) => {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  git("init", "-q", "-b", branch);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "flow test");
  git("config", "commit.gpgsign", "false");
  write("README.md", "test\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, git, write, cleanup: () => removeDir(dir) };
}

export function runScript(script, input, env = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    cwd: os.tmpdir(),
    env: { ...process.env, FLOW_NOTIFY: "off", ...env },
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}
