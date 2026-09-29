// Detects the facts about this machine that the template must not hard-code: OS, where Docker and
// Python run, the WSL distro and Smart App Control. Every probe is a command that may fail.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const OS_NAMES = { windows: "Windows", macos: "macOS", linux: "Linux" };
const osOf = (platform) => (platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux");

const TOOLS = ["git", "node", "gh", "glab", "docker", "uv", "python3", "dotnet", "jq"];
const FORGE_CLIS = ["gh", "glab"];
const PROBE_TIMEOUT_MS = 5000;
// The first command in a distro may have to start it (measured: 4.3 s warm VM, longer after boot).
const WSL_PROBE_TIMEOUT_MS = 30000;
// A cold `where` on Windows can take longer than a probe (measured: over 5 s on a fresh CI runner);
// a tool that is not there answers at once, so waiting costs nothing.
const LOOKUP_TIMEOUT_MS = 30000;
// `auth status` asks the forge's API whether each token still works.
const AUTH_TIMEOUT_MS = 15000;
// On these hosts only the user's own namespace is theirs; any other host is a company's own instance.
const PUBLIC_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
export const SOURCE_CONTROL_PREFIX = "Source control (detected on this machine): ";

export function defaultRun(file, args, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Without the Command Line Tools, these macOS files only offer to install them.
const MACOS_STUBS = ["/usr/bin/git", "/usr/bin/python3"];

// `where` on Windows, `which` on macOS, the shell's `command -v` on Linux, where `which` is not always
// installed. The Microsoft Store alias in WindowsApps is not a real tool.
function lookup(tool, platform, run) {
  const options = { timeoutMs: LOOKUP_TIMEOUT_MS };
  if (platform === "win32") return run("where", [tool], options);
  if (platform === "darwin") return run("which", [tool], options);
  return run("sh", ["-c", 'command -v "$1"', "sh", tool], options);
}

export function onPath(tool, { platform = process.platform, run = defaultRun } = {}) {
  const result = lookup(tool, platform, run);
  const found = result.ok ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/\\WindowsApps\\/i.test(line)) : [];
  if (platform === "darwin" && found.length > 0 && found.every((file) => MACOS_STUBS.includes(file))) return run("xcode-select", ["-p"]).ok;
  return found.length > 0;
}

export function missingToolMessage(tool, platform = process.platform) {
  const hint = platform === "darwin" && MACOS_STUBS.includes(`/usr/bin/${tool}`) ? " Install the Command Line Tools: xcode-select --install" : "";
  return `Missing prerequisite: '${tool}' is not installed.${hint}`;
}

function detectWsl(run) {
  const list = run("wsl.exe", ["-l", "-q"]);
  if (!list.ok) return null;
  const distros = list.stdout.replace(/\0/g, "").split(/\r?\n/).map((name) => name.trim())
    .filter((name) => name && !/^docker-desktop/i.test(name));
  for (const distro of distros) {
    const probe = run(
      "wsl.exe",
      ["-d", distro, "--exec", "bash", "-lc", "command -v docker; command -v uv || command -v python3"],
      { timeoutMs: WSL_PROBE_TIMEOUT_MS },
    );
    const docker = /\/docker\s*$/m.test(probe.stdout);
    const python = /\/(uv|python3)\s*$/m.test(probe.stdout);
    if (docker || python) return { distro, docker, python };
  }
  return null;
}

function detectSmartAppControl(run) {
  const result = run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy", "/v", "VerifiedAndReputablePolicyState"]);
  return result.ok && /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x1\b/.test(result.stdout);
}

// gh prints "Logged in to <host> account <user>", glab "Logged in to <host> as <user>" (on stderr).
// Both exit non-zero when one of several hosts fails, so the text counts, not the exit code.
export function parseAuthStatus(cli, text) {
  const forges = [];
  for (const [, host, user] of text.matchAll(/Logged in to (\S+) (?:account|as) ([^\s(]+)/g)) {
    const forge = { cli, host: host.toLowerCase(), user };
    if (!forges.some((known) => known.host === forge.host && known.user === forge.user)) forges.push(forge);
  }
  return forges;
}

function detectForges(tools, run) {
  return FORGE_CLIS.filter((cli) => tools[cli]).flatMap((cli) => {
    const result = run(cli, ["auth", "status"], { timeoutMs: AUTH_TIMEOUT_MS });
    return parseAuthStatus(cli, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  });
}

const readOsRelease = () => fs.readFileSync("/etc/os-release", "utf8");

// The distribution's PRETTY_NAME (for example "Ubuntu 24.04.1 LTS"), or null without /etc/os-release.
function linuxVersion(osRelease) {
  try {
    return /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(osRelease())?.[1] || null;
  } catch {
    return null;
  }
}

function osVersion(system, { release, run, osRelease }) {
  if (system === "windows") return release;
  if (system === "macos") return run("sw_vers", ["-productVersion"]).stdout.trim() || release;
  return linuxVersion(osRelease) ?? release;
}

export function detectMachine({
  platform = process.platform, arch = process.arch, release = os.release(), run = defaultRun, osRelease = readOsRelease,
} = {}) {
  const windows = platform === "win32";
  const system = osOf(platform);
  const tools = Object.fromEntries(TOOLS.map((tool) => [tool, onPath(tool, { platform, run })]));
  const machine = {
    os: system,
    arch,
    osVersion: osVersion(system, { release, run, osRelease }),
    hookShell: windows ? "git-bash" : "sh",
    tools,
    forges: detectForges(tools, run),
  };
  const dockerOnHost = tools.docker && run("docker", ["version", "--format", "{{.Server.Version}}"]).ok;
  const pythonOnHost = tools.uv || tools.python3;
  const wsl = windows && (!dockerOnHost || !pythonOnHost) ? detectWsl(run) : null;
  machine.docker = dockerOnHost ? "native" : wsl?.docker ? "wsl" : "none";
  machine.python = pythonOnHost ? "native" : wsl?.python ? "wsl" : "none";
  if (wsl) machine.wsl = { distro: wsl.distro };
  if (windows) machine.smartAppControl = detectSmartAppControl(run);
  return machine;
}

function runsWhere(machine, kind) {
  const name = kind === "docker" ? "Docker" : "Python";
  if (machine[kind] === "native") return `${name} runs on the host`;
  if (machine[kind] === "wsl") return `${name} runs in WSL distro ${machine.wsl.distro}`;
  if (kind === "docker" && machine.tools?.docker) return "Docker is installed on the host but was not running at install time";
  return `${name} is not installed`;
}

// Recognises the lines machineEnvironmentLines writes; they belong to the machine, never to a profile.
export const isMachineLine = (line) => /^Host: (Windows|macOS|Linux) workstation \(/.test(line) || line.startsWith(SOURCE_CONTROL_PREFIX);

export function machineEnvironmentLine(machine) {
  const host = OS_NAMES[machine.os] ?? machine.os;
  return `Host: ${host} workstation (${machine.arch}); ${runsWhere(machine, "docker")}; ${runsWhere(machine, "python")}.`;
}

export function sourceControlLine(machine) {
  const parts = [];
  for (const { host, user } of machine.forges ?? []) {
    const part = PUBLIC_HOSTS.has(host) ? `${host}/${user} and the repositories under it` : `every repository on ${host}`;
    if (!parts.includes(part)) parts.push(part);
  }
  return parts.length ? `${SOURCE_CONTROL_PREFIX}${parts.join("; ")}.` : null;
}

// Every autoMode.environment line that belongs to the machine, never to a profile.
export function machineEnvironmentLines(machine) {
  return [machineEnvironmentLine(machine), sourceControlLine(machine)].filter(Boolean);
}

export function forgesLine(machine) {
  const forges = machine.forges ?? [];
  if (forges.length === 0) return "Forges: no forge CLI is signed in.";
  return `Forges: ${forges.map((forge) => `${forge.cli} is signed in to ${forge.host} as ${forge.user}`).join("; ")}.`;
}

export function toolsLine(machine) {
  const present = Object.keys(machine.tools).filter((tool) => machine.tools[tool]);
  const missing = Object.keys(machine.tools).filter((tool) => !machine.tools[tool]);
  return `Tools on the host: ${present.join(", ") || "none"}.${missing.length ? ` Not installed: ${missing.join(", ")}.` : ""}`;
}

export function renderMachineMd(machine) {
  const windows = machine.os === "windows";
  const quote = (text) => text.replace(/WSL distro (\S+)/, "WSL distro `$1`");
  const lines = [
    "# This machine",
    "",
    "Generated by the claude-setup installer on every run; do not edit.",
    "",
    `- OS: ${OS_NAMES[machine.os] ?? machine.os} ${machine.osVersion} (${machine.arch}). Hooks run in ${windows ? "Git Bash" : "sh"}.`,
    `- ${toolsLine(machine)}`,
    `- ${quote(runsWhere(machine, "docker"))}. ${quote(runsWhere(machine, "python"))}.`,
  ];
  const forges = machine.forges ?? [];
  lines.push(forges.length
    ? `- Forges: ${forges.map((forge) => `\`${forge.cli}\` is signed in to ${forge.host} as \`${forge.user}\``).join("; ")}. \`/flow:ship\` uses the CLI that matches the repository's remote.`
    : "- No forge CLI is signed in: `/flow:ship` pushes the branch, and on GitLab push options open the merge request.");
  if (machine.wsl) {
    lines.push("- Use the `flow:wsl` skill for container tests and Python commands; `.claude/flow.json` commands with `\"runIn\": \"linux\"` run in that distro.");
  }
  if (machine.smartAppControl) {
    lines.push('- Smart App Control is on. "An Application Control policy has blocked this file (0x800711C7)" or "Zero tests ran" is the environment, not the code: re-run the tests through the `flow:wsl` skill. Never suggest turning Smart App Control off.');
  }
  return `${lines.join("\n")}\n`;
}
