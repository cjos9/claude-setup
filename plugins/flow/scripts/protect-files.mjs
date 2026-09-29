#!/usr/bin/env node
// PreToolUse hook: keeps Claude's file tools away from secrets, .git internals, lockfiles and sops files.
import { preToolUseDecision, runHook } from "./lib/hook-io.mjs";
import { fileRisk } from "./lib/file-rules.mjs";

await runHook(async (input) => {
  const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const reason = fileRisk(input.tool_name, filePath);
  return reason ? preToolUseDecision("deny", `flow: ${reason}`) : null;
});
