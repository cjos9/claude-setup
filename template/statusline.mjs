#!/usr/bin/env node
// Claude Code status line: model, git branch, context usage, 5-hour and 7-day limits.
// Claude Code passes session data as JSON on stdin; see https://code.claude.com/docs/en/statusline
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const SEPARATOR = `${DIM} │ ${RESET}`;
const BAR_WIDTH = 10;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

function colorFor(percent) {
  if (percent >= 80) return RED;
  if (percent >= 50) return YELLOW;
  return GREEN;
}

function bar(percent) {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)));
  return "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function tokens(count) {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1))}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function clock(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// The weekday in the language of `locale`; undefined means the system's.
export function weekdayClock(date, locale) {
  return `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date)} ${clock(date)}`;
}

function gitBranch(cwd) {
  if (!cwd) return null;
  const git = (args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    // An empty branch name means a detached HEAD; show the short commit instead.
    return git(["branch", "--show-current"]) || `@${git(["rev-parse", "--short", "HEAD"])}`;
  } catch {
    return null; // not a repository, or git unavailable
  }
}

function contextPart(context) {
  if (context?.used_percentage == null) return `${DIM}${"░".repeat(BAR_WIDTH)} –${RESET}`;
  const percent = context.used_percentage;
  const usage = context.current_usage;
  // Same input-only formula Claude Code uses for used_percentage.
  const used = usage
    ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    : null;
  const detail = used != null && context.context_window_size
    ? ` ${DIM}(${tokens(used)}/${tokens(context.context_window_size)})${RESET}`
    : "";
  return `${colorFor(percent)}${bar(percent)} ${Math.round(percent)}%${RESET}${detail}`;
}

function limitPart(label, window, formatReset) {
  // rate_limits exist only for Claude.ai Pro/Max and only after the first API response.
  if (window?.used_percentage == null) return `${DIM}${label} –${RESET}`;
  const reset = window.resets_at ? ` ${DIM}↻${formatReset(new Date(window.resets_at * 1000))}${RESET}` : "";
  return `${label} ${colorFor(window.used_percentage)}${Math.round(window.used_percentage)}%${RESET}${reset}`;
}

async function main() {
  let data = {};
  try {
    data = JSON.parse((await readStdin()) || "{}");
  } catch {
    // Malformed input: still render what we can.
  }

  const cwd = data.workspace?.current_dir ?? data.cwd;
  const branch = data.worktree?.branch ?? gitBranch(cwd);
  const parts = [
    `${BOLD}${CYAN}${data.model?.display_name ?? "?"}${RESET}`,
    ...(branch ? [`${MAGENTA}⎇ ${branch}${RESET}`] : []),
    contextPart(data.context_window),
    limitPart("5h", data.rate_limits?.five_hour, clock),
    limitPart("7d", data.rate_limits?.seven_day, (date) => weekdayClock(date)),
  ];

  process.stdout.write(parts.join(SEPARATOR) + "\n");
}

// Real paths on both sides: Claude Code may start the script through a symlinked folder.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
