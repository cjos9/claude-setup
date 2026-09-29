#!/usr/bin/env node
// Mirrors the current git repository into WSL (~/verify/<repo>-<hash>) and runs a command there.
// Usage, from anywhere inside the repo: node wsl-verify.mjs <command...>
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMachine } from "../../scripts/lib/check.mjs";

// The distro the claude-setup installer detected; FLOW_WSL_DISTRO overrides it.
const DISTRO = process.env.FLOW_WSL_DISTRO ?? readMachine()?.wsl?.distro ?? null;

export function toWslPath(windowsPath) {
  const normalized = windowsPath.replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) throw new Error(`Not a Windows drive path: ${windowsPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`.replace(/\/+$/, "");
}

export function isSafeMirrorSource(wslPath) {
  // Strip trailing slashes first
  const normalized = wslPath.replace(/\/+$/, "");

  // Reject empty, root, and /mnt
  if (!normalized || normalized === "/" || normalized === "/mnt") return false;

  // Reject drive roots like /mnt/c
  if (/^\/mnt\/[a-zA-Z]$/.test(normalized)) return false;

  // Reject path segments that are exactly ".."
  const segments = normalized.split("/");
  if (segments.includes("..")) return false;

  // Only accept paths under /mnt/<letter>/ with at least one more component
  return /^\/mnt\/[a-zA-Z]\//.test(normalized);
}

function main(command) {
  if (command.length === 0) {
    console.error("usage: node wsl-verify.mjs <command...>");
    return 2;
  }
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch (e) {
    console.error("wsl-verify: run this from inside a git repository");
    return 2;
  }
  if (!DISTRO) {
    console.error("wsl-verify: No WSL distro with Docker or Python was detected. Set one up, then run the claude-setup installer again (or set FLOW_WSL_DISTRO).");
    return 2;
  }
  const script = toWslPath(path.join(path.dirname(fileURLToPath(import.meta.url)), "wsl-verify.sh"));
  const wslRoot = toWslPath(root);
  if (!isSafeMirrorSource(wslRoot)) {
    console.error("wsl-verify: invalid mirror source path");
    return 2;
  }
  const result = spawnSync("wsl.exe", ["-d", DISTRO, "--", "bash", script, wslRoot, ...command], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`wsl-verify: could not start wsl.exe: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
