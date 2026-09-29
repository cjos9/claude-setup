#!/usr/bin/env node
// Installs the claude-setup template, an optional profile and the detected machine facts into
// ~/.claude. Usage: install.mjs [--profile <dir>] [--pull] [--no-plugins]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importLine, importTarget, updateManagedBlock } from "./lib/claude-md.mjs";
import {
  detectMachine, forgesLine, machineEnvironmentLine, machineEnvironmentLines, missingToolMessage, onPath, renderMachineMd, toolsLine,
} from "./lib/machine.mjs";
import { ensureMarketplace, ensurePluginMarketplaces, installMissing, isInstalled, pluginIds, refreshPlugin } from "./lib/plugins.mjs";
import {
  changedKeys, deepEqual, dropStaleListEntries, dropStaleProfileKeys, keepOwnAutoMode, layerSettings, managedLists,
  mergeIntoUser, pullToProfile, resolvePlaceholders, unresolvePlaceholders,
} from "./lib/settings.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE = "claude-setup";
const FLOW = `flow@${MARKETPLACE}`;
const KEEP_BACKUPS = 10;
const INSTALLED = "installed.json"; // the profile, its keys and values, the permission lists, autoMode and enabledPlugins the last install put into settings.json
// The template's permission lists and plugins as installs put them into settings.json before
// installed.json recorded them.
const UNRECORDED_PLUGINS = {
  "superpowers@claude-plugins-official": true, "context7@claude-plugins-official": true,
  "code-simplifier@claude-plugins-official": true, "claude-md-management@claude-plugins-official": true, [FLOW]: true,
};
const UNRECORDED_LISTS = {
  deny: [
    "Read(.env)", "Read(.env.local)", "Read(.env.*.local)", "Read(.env.production)", "Read(.env.development)",
    "Read(.env.staging)", "Read(.env.test)", "Read(*.pfx)", "Read(*.p12)", "Read(*.key)", "Read(id_rsa*)",
    "Read(id_ed25519*)", "Read(~/.ssh/id_*)", "Read(~/.claude/.credentials.json)", "Bash(git push --force *)",
    "Bash(git push -f *)",
  ],
};

class UserError extends Error {}

function parseArgs(argv) {
  const args = { profile: null, pull: false, plugins: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile" && argv[i + 1]) args.profile = argv[++i];
    else if (argv[i] === "--pull") args.pull = true;
    else if (argv[i] === "--no-plugins") args.plugins = false;
    else return null;
  }
  return args;
}

// A relative profile path is looked up from the current directory, then from the repository.
function resolveProfile(dir, cwd) {
  const fromCwd = path.resolve(cwd, dir);
  const fromRepo = path.resolve(REPO, dir);
  return !fs.existsSync(fromCwd) && fs.existsSync(fromRepo) ? fromRepo : fromCwd;
}

// Lenient: a missing or unreadable file counts as `fallback`. For Claude Code's own bookkeeping
// files and the installer's state, where starting over is safe.
function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

// Strict: only a missing file counts as empty. A settings file that does not parse stops the
// install, because treating it as empty would overwrite the user's own keys.
function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new UserError(`${file} is not valid JSON (${error.message}). Fix it, then run the installer again.`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The claude CLI is an .exe or a .cmd shim on Windows; the shell finds both. With a shell, Node wants
// one command string (arguments next to shell: true are deprecated), so quote and join them here.
function runClaude(args) {
  const windows = process.platform === "win32";
  const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  const result = windows
    ? spawnSync(["claude", ...args.map(quote)].join(" "), { encoding: "utf8", shell: true, windowsHide: true })
    : spawnSync("claude", args, { encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function backup(claudeDir, log) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 19); // 20260925-074411.123: two runs in one second get two folders
  const backups = path.join(claudeDir, "backups");
  const target = path.join(backups, `claude-setup-${stamp}`);
  fs.mkdirSync(target, { recursive: true });
  for (const file of ["settings.json", "CLAUDE.md"]) {
    const source = path.join(claudeDir, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, file));
  }
  const all = fs.readdirSync(backups).filter((name) => name.startsWith("claude-setup-")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(backups, old), { recursive: true, force: true });
  log(`Backup: ${target}`);
}

function machineFacts(stateDir) {
  const override = process.env.CLAUDE_SETUP_MACHINE;
  const machine = override ? readJson(override, null) : detectMachine();
  if (!machine) throw new UserError(`CLAUDE_SETUP_MACHINE points to an unreadable file: ${override}`);
  writeJson(path.join(stateDir, "machine.json"), machine);
  fs.writeFileSync(path.join(stateDir, "machine.md"), renderMachineMd(machine));
  return machine;
}

// A team's fork adds its own layer in team/; CLAUDE_SETUP_TEAM points to another folder, a relative
// one from the current folder.
const teamDir = () => (process.env.CLAUDE_SETUP_TEAM ? path.resolve(process.env.CLAUDE_SETUP_TEAM) : path.join(REPO, "team"));

// The team layers over the template, and from then on both count as the base: what a profile adds
// on top of it is the profile's, the rest never goes into a profile.
function layers(profile, machine) {
  const team = teamDir();
  const vars = { REPO, TEAM: team, PROFILE: profile };
  const template = resolvePlaceholders(readSettings(path.join(REPO, "template", "settings.json")), vars);
  const teamSettings = resolvePlaceholders(readSettings(path.join(team, "settings.json")), vars);
  const profileSettings = profile ? resolvePlaceholders(readSettings(path.join(profile, "settings.json")), vars) : {};
  return { vars, template: layerSettings(template, teamSettings), profileSettings, machineLines: machine ? machineEnvironmentLines(machine) : [] };
}

// The permission lists the last install put into settings.json; null before the first install.
const previousLists = (installed) => (installed ? installed.lists ?? UNRECORDED_LISTS : null);
const previousPlugins = (installed) => (installed ? installed.plugins ?? UNRECORDED_PLUGINS : {});

// settings.json only reflects the profile that was installed on this machine, so --pull writes into
// that one. Installs from before installed.json existed are known from config.json.
function pull({ claudeDir, stateDir, profile, rememberedProfile, log }) {
  if (!profile) throw new UserError("--pull needs a profile: run the installer with --profile <dir> first");
  const installed = readJson(path.join(stateDir, INSTALLED), null);
  const installedProfile = installed ? installed.profile : rememberedProfile;
  if (installedProfile !== profile) {
    throw new UserError(`--pull writes into the profile installed on this machine (${installedProfile ?? "none"}). Run the installer with --profile ${profile} first.`);
  }
  const machine = readJson(path.join(stateDir, "machine.json"), null);
  const { vars, template, profileSettings, machineLines } = layers(profile, machine);
  const managed = layerSettings(template, profileSettings, machineLines);
  const user = dropStaleListEntries(readSettings(path.join(claudeDir, "settings.json")), previousLists(installed), managed);
  const installedKeys = Array.isArray(installed?.keys) ? installed.keys : [];
  const next = pullToProfile(user, template, profileSettings, machineLines, installedKeys, previousPlugins(installed));
  if (deepEqual(next, profileSettings)) {
    log("Profile settings already match ~/.claude/settings.json");
    return;
  }
  writeJson(path.join(profile, "settings.json"), unresolvePlaceholders(next, vars));
  log(`Updated ${path.join(profile, "settings.json")}: ${changedKeys(profileSettings, next).join(", ")}. Review it with git diff.`);
}

function plugins({ claudeDir, managed, log }) {
  const known = readJson(path.join(claudeDir, "plugins", "known_marketplaces.json"), null);
  const marketplace = ensureMarketplace({ run: runClaude, known, name: MARKETPLACE, dir: REPO });
  if (marketplace !== "current") log(`Marketplace ${MARKETPLACE} ${marketplace} at ${REPO}`);
  const { added, unknown } = ensurePluginMarketplaces({ run: runClaude, known, ids: pluginIds(managed) });
  for (const name of added) log(`Marketplace ${name} added`);
  for (const name of unknown) console.warn(`warning: plugins from marketplace ${name} need it registered first: claude plugin marketplace add <source of ${name}>`);
  const flowWasInstalled = isInstalled(runClaude(["plugin", "list"]).stdout, FLOW);
  const { installed, failed } = installMissing({ run: runClaude, ids: pluginIds(managed) });
  for (const id of installed) log(`Installed plugin ${id}`);
  for (const id of failed) console.warn(`warning: could not install plugin ${id}; install it with: claude plugin install ${id}`);
  if (!flowWasInstalled) return;
  const readSha = () => {
    const entry = readJson(path.join(claudeDir, "plugins", "installed_plugins.json"), null)?.plugins?.[FLOW]?.[0];
    return entry?.gitCommitSha?.slice(0, 7) ?? null;
  };
  const { before, after } = refreshPlugin({ run: runClaude, readSha, id: FLOW, marketplace: MARKETPLACE });
  log(before && before === after ? `flow plugin already current (${after})` : `flow plugin updated (${before} -> ${after}); restart running Claude Code sessions`);
}

function claudeMd({ home, claudeDir, stateDir, profile, log }) {
  const teamMd = path.join(teamDir(), "CLAUDE.md");
  const files = [
    importTarget(path.join(REPO, "template", "CLAUDE.md"), stateDir, "template.md"),
    fs.existsSync(teamMd) ? importTarget(teamMd, stateDir, "team.md") : null,
    profile && fs.existsSync(path.join(profile, "CLAUDE.md")) ? importTarget(path.join(profile, "CLAUDE.md"), stateDir, "profile.md") : null,
    path.join(stateDir, "machine.md"),
  ].filter(Boolean);
  const file = path.join(claudeDir, "CLAUDE.md");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const next = updateManagedBlock(current, files.map((f) => importLine(f, home)));
  if (next === current) return log("CLAUDE.md already up to date");
  fs.writeFileSync(file, next);
  log("CLAUDE.md imports updated");
}

function profileSetup({ profile, stateDir, log }) {
  const script = profile && path.join(profile, "setup.mjs");
  if (!script || !fs.existsSync(script)) return;
  const result = spawnSync(process.execPath, [script, path.join(stateDir, "machine.json")], { cwd: profile, stdio: "inherit" });
  if (result.status === 0) log("Profile setup.mjs done");
  else console.warn(`warning: profile setup.mjs failed (exit ${result.status})`);
}

export function main(argv, { home = os.homedir(), cwd = process.cwd(), log = console.log } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    console.error("usage: install.mjs [--profile <dir>] [--pull] [--no-plugins]");
    return 2;
  }
  try {
    for (const tool of ["git", ...(args.plugins ? ["claude"] : [])]) {
      if (!onPath(tool)) throw new UserError(missingToolMessage(tool));
    }
    const claudeDir = path.join(home, ".claude");
    const stateDir = path.join(claudeDir, "claude-setup");
    const configFile = path.join(stateDir, "config.json");
    const config = readJson(configFile);
    const profile = args.profile ? resolveProfile(args.profile, cwd) : config.profile ?? null;
    if (profile && !fs.existsSync(profile)) throw new UserError(`The profile ${profile} does not exist. Pass --profile <dir> again.`);
    if (args.pull) {
      pull({ claudeDir, stateDir, profile, rememberedProfile: config.profile ?? null, log });
      return 0;
    }
    if (profile !== (config.profile ?? null)) writeJson(configFile, { ...config, profile });

    // Read every settings file before changing anything, so a file that does not parse stops the
    // install before plugins or settings are touched.
    const settingsFile = path.join(claudeDir, "settings.json");
    const user = readSettings(settingsFile);
    layers(profile, null);

    backup(claudeDir, log);
    const machine = machineFacts(stateDir);
    const { template, profileSettings, machineLines } = layers(profile, machine);
    log(`Machine: ${machineEnvironmentLine(machine)}`);
    log(toolsLine(machine));
    log(forgesLine(machine));
    const managed = layerSettings(template, profileSettings, machineLines);
    if (args.plugins) plugins({ claudeDir, managed, log });

    const previous = readJson(path.join(stateDir, INSTALLED), null);
    const current = dropStaleListEntries(dropStaleProfileKeys(user, previous, managed), previousLists(previous), managed);
    const next = mergeIntoUser(current, keepOwnAutoMode(user, managed, previous));
    const changed = changedKeys(user, next);
    if (changed.length === 0) log("settings.json already up to date");
    else {
      writeJson(settingsFile, next);
      log(`settings.json updated: ${changed.join(", ")}`);
    }
    writeJson(path.join(stateDir, INSTALLED), { profile, keys: Object.keys(profileSettings), values: profileSettings, lists: managedLists(managed), autoMode: managed.autoMode ?? {}, plugins: managed.enabledPlugins ?? {} });
    claudeMd({ home, claudeDir, stateDir, profile, log });
    profileSetup({ profile, stateDir, log });
    return 0;
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
