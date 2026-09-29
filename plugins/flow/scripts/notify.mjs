#!/usr/bin/env node
// Notification hook: shows a desktop notification (Windows toast, macOS Notification Center,
// notify-send on Linux) so you notice when Claude waits for you. FLOW_NOTIFY=off turns it off.
import { runHook } from "./lib/hook-io.mjs";
import { showNotification, toastTitle } from "./lib/toast.mjs";

await runHook(async (input) => {
  if (process.env.FLOW_NOTIFY === "off") return null;
  await showNotification(toastTitle(input.cwd), input.message || "Claude Code needs your attention");
  return null;
});
