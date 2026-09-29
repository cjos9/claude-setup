#!/usr/bin/env node
// Stop hook: when the project defines a check in .claude/flow.json and relevant code changed,
// run it and keep Claude working until it passes. Each failing state blocks once.
import { runHook } from "./lib/hook-io.mjs";
import { evaluateStop } from "./lib/check.mjs";

await runHook(async (input) => evaluateStop(input));
