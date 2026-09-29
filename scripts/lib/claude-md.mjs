// Keeps the installer's imports in ~/.claude/CLAUDE.md inside a marked block, so the user's own
// text stays untouched.
import fs from "node:fs";
import path from "node:path";

export const BEGIN = "<!-- claude-setup:begin -->";
export const END = "<!-- claude-setup:end -->";
const LEGACY_IMPORT = /^@\S*\/claude-setup\/user\/CLAUDE\.md$/;

const posix = (file) => file.replace(/\\/g, "/");

// Every installer so far left its imports in CLAUDE.md: the managed block, or the first one's import line.
export const hasSetupImports = (text) => text.includes(BEGIN) || text.split(/\r?\n/).some((line) => LEGACY_IMPORT.test(line.trim()));

export function importLine(file, home) {
  const full = posix(file);
  const base = posix(home).replace(/\/+$/, "");
  return full.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? `@~/${full.slice(base.length + 1)}` : `@${full}`;
}

// @-imports end at whitespace, so a file whose path has spaces is imported through a copy.
export function importTarget(file, stateDir, name) {
  if (!/\s/.test(file)) return file;
  const copy = path.join(stateDir, name);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.copyFileSync(file, copy);
  return copy;
}

// A complete block is a BEGIN with no other BEGIN before its END. The first one is replaced, any
// further one goes with its imports, and stray marker lines are dropped: exactly one block remains.
const BLOCK = `${BEGIN}(?:(?!${BEGIN})[\\s\\S])*?${END}`;
const clean = (part) => part.replace(new RegExp(BLOCK, "g"), "").split("\n")
  .filter((line) => line.trim() !== BEGIN && line.trim() !== END).join("\n");

export function updateManagedBlock(text, lines) {
  const block = [BEGIN, ...lines, END].join("\n");
  const body = text.split(/\r?\n/).filter((line) => !LEGACY_IMPORT.test(line.trim())).join("\n");
  const first = new RegExp(BLOCK).exec(body);
  const next = first
    ? clean(body.slice(0, first.index)) + block + clean(body.slice(first.index + first[0].length))
    : [block, clean(body).trim()].filter(Boolean).join("\n\n");
  return `${next.trim()}\n`;
}
