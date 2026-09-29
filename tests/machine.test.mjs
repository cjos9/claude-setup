import test from "node:test";
import assert from "node:assert/strict";
import {
  detectMachine, forgesLine, isMachineLine, machineEnvironmentLine, machineEnvironmentLines, missingToolMessage,
  parseAuthStatus, renderMachineMd, sourceControlLine,
} from "../scripts/lib/machine.mjs";

// A fake command runner: `answers` maps "file arg1 arg2" prefixes to stdout or to a partial result;
// anything else fails.
function fakeRun(answers) {
  return (file, args) => {
    const line = [file, ...args].join(" ");
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    if (key === undefined) return { ok: false, stdout: "", stderr: "" };
    const answer = answers[key];
    return typeof answer === "string" ? { ok: true, stdout: answer, stderr: "" } : { ok: true, stdout: "", stderr: "", ...answer };
  };
}

test("the per-distro WSL probe may take long enough for a cold start", () => {
  const timeouts = {};
  const run = (file, args, options = {}) => {
    timeouts[[file, ...args].slice(0, 3).join(" ")] = options.timeoutMs;
    if (file === "wsl.exe" && args[0] === "-l") return { ok: true, stdout: "Dev\r\n" };
    if (file === "wsl.exe") return { ok: true, stdout: "/usr/bin/docker\n" };
    return { ok: false, stdout: "" };
  };
  detectMachine({ platform: "win32", arch: "x64", release: "10.0.26200", run });
  assert.ok(timeouts["wsl.exe -d Dev"] >= 30000, `probe timeout ${timeouts["wsl.exe -d Dev"]}`);
});

test("the tool lookup may take long enough for a cold start on every system", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const timeouts = [];
    const run = (file, args, options = {}) => {
      if (["where", "which", "sh"].includes(file)) timeouts.push(options.timeoutMs);
      return { ok: false, stdout: "" };
    };
    detectMachine({ platform, arch: "x64", release: "1", run, osRelease: () => "" });
    assert.ok(timeouts.length > 0 && timeouts.every((ms) => ms >= 30000), `${platform}: ${timeouts}`);
  }
});

const WINDOWS_WITH_WSL = fakeRun({
  "where git": "C:\\Program Files\\Git\\cmd\\git.exe\r\n",
  "where node": "C:\\nvm4w\\nodejs\\node.exe\r\n",
  "where python3": "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe\r\n",
  "wsl.exe -l -q": "d\0o\0c\0k\0e\0r\0-\0d\0e\0s\0k\0t\0o\0p\0\r\0\n\0D\0e\0v\0\r\0\n\0",
  "wsl.exe -d Dev --exec bash -lc": "/usr/bin/docker\n/home/u/.local/bin/uv\n",
  "reg query": "    VerifiedAndReputablePolicyState    REG_DWORD    0x1\r\n",
});

test("Windows with Docker and uv in WSL", () => {
  const machine = detectMachine({ platform: "win32", arch: "x64", release: "10.0.26200", run: WINDOWS_WITH_WSL });
  assert.equal(machine.os, "windows");
  assert.equal(machine.hookShell, "git-bash");
  assert.equal(machine.docker, "wsl");
  assert.equal(machine.python, "wsl");
  assert.deepEqual(machine.wsl, { distro: "Dev" });
  assert.equal(machine.smartAppControl, true);
  assert.equal(machine.tools.python3, false, "the WindowsApps stub is not Python");
  assert.equal(machine.tools.git, true);
});

test("Windows without WSL and with Smart App Control off", () => {
  const machine = detectMachine({
    platform: "win32", arch: "x64", release: "10.0.22631",
    run: fakeRun({ "where git": "C:\\git.exe", "reg query": "VerifiedAndReputablePolicyState    REG_DWORD    0x0" }),
  });
  assert.equal(machine.docker, "none");
  assert.equal(machine.python, "none");
  assert.equal(machine.wsl, undefined);
  assert.equal(machine.smartAppControl, false);
});

test("macOS with Docker and uv on the host", () => {
  const machine = detectMachine({
    platform: "darwin", arch: "arm64", release: "24.0.0",
    run: fakeRun({
      "sw_vers -productVersion": "15.1\n",
      "which docker": "/usr/local/bin/docker\n",
      "which uv": "/Users/u/.local/bin/uv\n",
      "docker version": "27.3.1\n",
    }),
  });
  assert.equal(machine.os, "macos");
  assert.equal(machine.osVersion, "15.1");
  assert.equal(machine.hookShell, "sh");
  assert.equal(machine.docker, "native");
  assert.equal(machine.python, "native");
  assert.equal(machine.wsl, undefined);
  assert.equal(machine.smartAppControl, undefined);
});

test("Linux with Docker and python3 on the host", () => {
  const machine = detectMachine({
    platform: "linux", arch: "x64", release: "6.8.0-45-generic",
    osRelease: () => 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nVERSION_ID="24.04"\n',
    run: fakeRun({
      'sh -c command -v "$1" sh docker': "/usr/bin/docker\n",
      'sh -c command -v "$1" sh python3': "/usr/bin/python3\n",
      "docker version": "27.3.1\n",
    }),
  });
  assert.equal(machine.os, "linux");
  assert.equal(machine.osVersion, "Ubuntu 24.04.1 LTS");
  assert.equal(machine.hookShell, "sh");
  assert.equal(machine.docker, "native");
  assert.equal(machine.python, "native");
  assert.equal(machine.wsl, undefined);
  assert.equal(machine.smartAppControl, undefined);
  const line = machineEnvironmentLine(machine);
  assert.equal(line, "Host: Linux workstation (x64); Docker runs on the host; Python runs on the host.");
  assert.ok(isMachineLine(line));
  assert.match(renderMachineMd(machine), /- OS: Linux Ubuntu 24\.04\.1 LTS \(x64\)\. Hooks run in sh\./);
});

test("Linux without /etc/os-release reports its kernel release", () => {
  const machine = detectMachine({
    platform: "linux", arch: "arm64", release: "6.8.0",
    osRelease: () => { throw new Error("ENOENT"); },
    run: fakeRun({}),
  });
  assert.equal(machine.osVersion, "6.8.0");
});

test("a Docker CLI without a running engine counts as no Docker", () => {
  const machine = detectMachine({
    platform: "darwin", arch: "arm64", release: "24.0.0",
    run: fakeRun({ "which docker": "/usr/local/bin/docker\n" }),
  });
  assert.equal(machine.docker, "none");
});

test("machine.md tells Claude where things run", () => {
  const windows = renderMachineMd(detectMachine({ platform: "win32", arch: "x64", release: "10.0.26200", run: WINDOWS_WITH_WSL }));
  assert.match(windows, /Windows 10\.0\.26200 \(x64\)/);
  assert.match(windows, /Hooks run in Git Bash/);
  assert.match(windows, /Docker runs in WSL distro `Dev`/);
  assert.match(windows, /`flow:wsl` skill/);
  assert.match(windows, /Smart App Control is on/);
  assert.match(windows, /Not installed: .*python3/);
  const mac = renderMachineMd({ os: "macos", arch: "arm64", osVersion: "15.1", hookShell: "sh", tools: { git: true }, docker: "native", python: "none" });
  assert.match(mac, /macOS 15\.1 \(arm64\)/);
  assert.match(mac, /Docker runs on the host/);
  assert.doesNotMatch(mac, /WSL|Smart App Control/);
});

test("the autoMode line names the host and where Docker and Python run", () => {
  assert.equal(
    machineEnvironmentLine({ os: "windows", arch: "x64", docker: "wsl", python: "wsl", wsl: { distro: "Dev" } }),
    "Host: Windows workstation (x64); Docker runs in WSL distro Dev; Python runs in WSL distro Dev.",
  );
  assert.equal(
    machineEnvironmentLine({ os: "macos", arch: "arm64", docker: "native", python: "none" }),
    "Host: macOS workstation (arm64); Docker runs on the host; Python is not installed.",
  );
});

test("a Docker CLI whose engine was not running is not reported as missing", () => {
  const machine = detectMachine({
    platform: "darwin", arch: "arm64", release: "24.0.0",
    run: fakeRun({ "which docker": "/usr/local/bin/docker\n" }),
  });
  assert.match(machineEnvironmentLine(machine), /Docker is installed on the host but was not running at install time;/);
  assert.match(renderMachineMd(machine), /Docker is installed on the host but was not running at install time\./);
});

test("the macOS git and python3 stubs count only with the Command Line Tools installed", () => {
  const stubs = { "which git": "/usr/bin/git\n", "which python3": "/usr/bin/python3\n" };
  const fresh = detectMachine({ platform: "darwin", arch: "arm64", release: "24.0.0", run: fakeRun(stubs) });
  assert.equal(fresh.tools.git, false);
  assert.equal(fresh.tools.python3, false);
  assert.equal(fresh.python, "none");
  const withTools = detectMachine({
    platform: "darwin", arch: "arm64", release: "24.0.0",
    run: fakeRun({ ...stubs, "xcode-select -p": "/Library/Developer/CommandLineTools\n" }),
  });
  assert.equal(withTools.tools.git, true);
  assert.equal(withTools.python, "native");
  const brew = detectMachine({ platform: "darwin", arch: "arm64", release: "24.0.0", run: fakeRun({ "which python3": "/opt/homebrew/bin/python3\n" }) });
  assert.equal(brew.tools.python3, true);
});

test("every machine line is recognised as one", () => {
  assert.equal(isMachineLine(machineEnvironmentLine({ os: "windows", arch: "x64", docker: "none", python: "none", tools: {} })), true);
  assert.equal(isMachineLine(machineEnvironmentLine({ os: "macos", arch: "arm64", docker: "native", python: "native" })), true);
  assert.equal(isMachineLine("Source control: github.com/me"), false);
  assert.equal(isMachineLine("Source control (detected on this machine): every repository on gitlab.example.com."), true);
});

test("a missing git on macOS points to the Command Line Tools", () => {
  assert.match(missingToolMessage("git", "darwin"), /xcode-select --install/);
  assert.doesNotMatch(missingToolMessage("claude", "darwin"), /xcode-select/);
  assert.doesNotMatch(missingToolMessage("git", "win32"), /xcode-select/);
});

const GH_STATUS = [
  "github.com",
  "  ✓ Logged in to github.com account octo (keyring)",
  "  - Active account: true",
  "  ✓ Logged in to github.com account octo-work (keyring)",
  "  - Active account: false",
  "",
].join("\n");
const GLAB_STATUS = [
  "gitlab.example.com",
  "  ✓ Logged in to gitlab.example.com as jdoe (/Users/u/.config/glab-cli/config.yml)",
  "  ✓ Git operations for gitlab.example.com configured to use ssh protocol.",
  "gitlab.com",
  "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}",
  "",
].join("\n");

test("both auth status formats are read, failed hosts are skipped", () => {
  assert.deepEqual(parseAuthStatus("gh", GH_STATUS), [
    { cli: "gh", host: "github.com", user: "octo" },
    { cli: "gh", host: "github.com", user: "octo-work" },
  ]);
  assert.deepEqual(parseAuthStatus("glab", GLAB_STATUS), [{ cli: "glab", host: "gitlab.example.com", user: "jdoe" }]);
  assert.deepEqual(parseAuthStatus("gh", "You are not logged into any GitHub hosts."), []);
});

test("signed-in forges are detected from stdout and stderr, whatever the exit code", () => {
  const machine = detectMachine({
    platform: "darwin", arch: "arm64", release: "24.0.0",
    run: fakeRun({
      "which gh": "/opt/homebrew/bin/gh\n",
      "which glab": "/opt/homebrew/bin/glab\n",
      "gh auth status": GH_STATUS,
      "glab auth status": { ok: false, stderr: GLAB_STATUS },
    }),
  });
  assert.equal(machine.tools.glab, true);
  assert.deepEqual(machine.forges.map((forge) => `${forge.cli}:${forge.host}:${forge.user}`), [
    "gh:github.com:octo", "gh:github.com:octo-work", "glab:gitlab.example.com:jdoe",
  ]);
});

test("without forge CLIs the forge list is empty and nothing is probed", () => {
  const probed = [];
  const run = (file, args) => {
    probed.push([file, ...args].join(" "));
    return { ok: false, stdout: "", stderr: "" };
  };
  const machine = detectMachine({ platform: "darwin", arch: "arm64", release: "24.0.0", run });
  assert.deepEqual(machine.forges, []);
  assert.equal(probed.some((line) => line.includes("auth status")), false);
});

test("the source control line trusts a namespace on public hosts and a whole self-hosted host", () => {
  assert.equal(sourceControlLine({ forges: [] }), null);
  assert.equal(sourceControlLine({}), null);
  assert.equal(
    sourceControlLine({ forges: [
      { cli: "gh", host: "github.com", user: "octo" },
      { cli: "glab", host: "gitlab.example.com", user: "jdoe" },
      { cli: "glab", host: "gitlab.example.com", user: "bot" },
    ] }),
    "Source control (detected on this machine): github.com/octo and the repositories under it; every repository on gitlab.example.com.",
  );
});

test("the machine lines are the host line, then the source control line when a forge is signed in", () => {
  const mac = { os: "macos", arch: "arm64", docker: "native", python: "native" };
  assert.deepEqual(machineEnvironmentLines(mac), [machineEnvironmentLine(mac)]);
  const withForge = { ...mac, forges: [{ cli: "glab", host: "gitlab.example.com", user: "jdoe" }] };
  assert.deepEqual(machineEnvironmentLines(withForge), [machineEnvironmentLine(mac), sourceControlLine(withForge)]);
  assert.equal(machineEnvironmentLines(withForge).every(isMachineLine), true);
});

test("the forges line and machine.md name each signed-in CLI", () => {
  const forges = [{ cli: "gh", host: "github.com", user: "octo" }, { cli: "glab", host: "gitlab.example.com", user: "jdoe" }];
  assert.equal(forgesLine({ forges }), "Forges: gh is signed in to github.com as octo; glab is signed in to gitlab.example.com as jdoe.");
  assert.equal(forgesLine({ forges: [] }), "Forges: no forge CLI is signed in.");
  const base = { os: "macos", arch: "arm64", osVersion: "15.1", hookShell: "sh", tools: { git: true }, docker: "native", python: "none" };
  assert.match(renderMachineMd({ ...base, forges }), /- Forges: `gh` is signed in to github\.com as `octo`; `glab` is signed in to gitlab\.example\.com as `jdoe`\./);
  assert.match(renderMachineMd({ ...base, forges: [] }), /- No forge CLI is signed in: `\/flow:ship` pushes the branch/);
});
