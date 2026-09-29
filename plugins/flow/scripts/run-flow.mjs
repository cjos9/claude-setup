#!/usr/bin/env node
// Runs .claude/flow.json's check or test the way the stop hook does (runIn included), with live
// output. Usage, from anywhere inside the repository: node run-flow.mjs check|test
import { spawnSync } from "node:child_process";
import { commandSpec, loadFlowConfig, readMachine, repoRoot } from "./lib/check.mjs";

const which = process.argv[2];
if (which !== "check" && which !== "test") {
  console.error("usage: run-flow.mjs check|test");
  process.exit(2);
}
const root = repoRoot(process.cwd());
const config = root ? loadFlowConfig(root) : null;
const command = config?.[which];
if (!command) {
  console.error(`run-flow: no "${which}" in .claude/flow.json`);
  process.exit(2);
}
const spec = commandSpec(command, { runIn: config.runIn, root, machine: readMachine() });
console.log(`flow ${which}: ${command}${spec.file === "wsl.exe" ? ` (in WSL ${spec.args[1]})` : ""}`);
const result = spawnSync(spec.file, spec.args, { cwd: root, shell: spec.shell, stdio: "inherit" });
process.exit(result.status ?? 1);
