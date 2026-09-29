import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "scripts", "install.mjs");
const MAC = { os: "macos", arch: "arm64", osVersion: "15.1", hookShell: "sh", tools: { git: true, node: true }, docker: "native", python: "native" };

function sandbox(t, machine = MAC) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "setup-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const machineFile = path.join(home, "fake-machine.json");
  fs.writeFileSync(machineFile, JSON.stringify(machine));
  // A fork's own team/ must not leak into these tests: without `team`, the team layer is a missing folder.
  const run = (args, { cwd = ROOT, fake = true, team = path.join(home, "no-team") } = {}) => spawnSync(process.execPath, [INSTALL, "--no-plugins", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_SETUP_TEAM: team, ...(fake ? { CLAUDE_SETUP_MACHINE: machineFile } : {}) },
  });
  const read = (file) => fs.readFileSync(path.join(home, ".claude", file), "utf8");
  return { home, run, read, json: (file) => JSON.parse(read(file)) };
}

function copyProfile(t, from = "example") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-profile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, "profiles", from), dir, { recursive: true });
  return dir;
}

function teamLayer(t, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-team-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Team rules\n");
  return dir;
}

const MAC_LINE = "Host: macOS workstation (arm64); Docker runs on the host; Python runs on the host.";

test("without a profile only template values and the machine line are installed", (t) => {
  const box = sandbox(t);
  const result = box.run([]);
  assert.equal(result.status, 0, result.stderr);
  const settings = box.json("settings.json");
  assert.equal(settings.model, undefined);
  assert.deepEqual(settings.autoMode.environment, ["$defaults", "Host: macOS workstation (arm64); Docker runs on the host; Python runs on the host."]);
  assert.match(settings.statusLine.command, /template\/statusline\.mjs"$/);
  const claudeMd = box.read("CLAUDE.md");
  assert.match(claudeMd, /claude-setup:begin -->\n@.*template\/CLAUDE\.md\n@~\/\.claude\/claude-setup\/machine\.md\n<!-- claude-setup:end/);
  assert.match(box.read("claude-setup/machine.md"), /macOS 15\.1/);
});

test("the real machine detection runs end to end", (t) => {
  const box = sandbox(t);
  const result = box.run([], { fake: false });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(box.json("claude-setup/machine.json").os);
});

test("a second run changes nothing but adds a backup", (t) => {
  const box = sandbox(t);
  box.run([]);
  const before = box.read("settings.json");
  const result = box.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.read("settings.json"), before);
  assert.match(result.stdout, /settings\.json already up to date/);
  assert.equal(fs.readdirSync(path.join(box.home, ".claude", "backups")).length, 2);
});

test("only the ten newest backups are kept", (t) => {
  const box = sandbox(t);
  const backups = path.join(box.home, ".claude", "backups");
  for (let i = 0; i < 12; i++) fs.mkdirSync(path.join(backups, `claude-setup-20200101-0000${String(i).padStart(2, "0")}`), { recursive: true });
  box.run([]);
  assert.equal(fs.readdirSync(backups).length, 10);
});

test("a relative profile path is stored absolute and reused from anywhere", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  const result = box.run(["--profile", path.basename(profile)], { cwd: path.dirname(profile) });
  assert.equal(result.status, 0, result.stderr);
  // macOS: the temp dir is a symlink (/var -> /private/var) and the child's cwd is the real path.
  assert.equal(fs.realpathSync(box.json("claude-setup/config.json").profile), fs.realpathSync(profile));
  const again = box.run([], { cwd: os.tmpdir() });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(box.json("settings.json").model, "opus");
  assert.match(box.read("CLAUDE.md"), /setup-profile-[^/]+\/CLAUDE\.md/);
});

test("a stored profile that no longer exists stops the install", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  box.run(["--profile", profile]);
  fs.rmSync(profile, { recursive: true, force: true });
  const result = box.run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /profile .* does not exist/);
});

test("the old installer's import and personal host line are replaced", (t) => {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(box.home, ".claude", "CLAUDE.md"), "@~/dev/claude-setup/user/CLAUDE.md\n\n# my own notes\n");
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify({
    theme: "dark", autoMode: { environment: ["$defaults", "Host containment: Windows 11 workstation with WSL2"] },
  }));
  box.run([]);
  const claudeMd = box.read("CLAUDE.md");
  assert.doesNotMatch(claudeMd, /user\/CLAUDE\.md/);
  assert.match(claudeMd, /# my own notes/);
  const settings = box.json("settings.json");
  assert.equal(settings.theme, "dark");
  assert.equal(settings.autoMode.environment.some((line) => line.startsWith("Host containment")), false);
});

test("on a machine that never ran the installer, the user's own autoMode entries stay", (t) => {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify({
    autoMode: { environment: ["$defaults", "Build server ci.example.com is trusted"], allow: ["Running the linters"] },
  }));
  const result = box.run([]);
  assert.equal(result.status, 0, result.stderr);
  const autoMode = box.json("settings.json").autoMode;
  assert.deepEqual(autoMode.environment, ["$defaults", MAC_LINE, "Build server ci.example.com is trusted"]);
  assert.deepEqual(autoMode.allow, ["Running the linters"]);
});

test("the first install names the user's values it replaced, later installs do not", (t) => {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify({
    theme: "dark", statusLine: { type: "command", command: "my-status" }, permissions: { defaultMode: "default", allow: ["Bash(ls)"] },
  }));
  const first = box.run([]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Replaced your values: statusLine\.command, permissions\.defaultMode\. The previous settings\.json is in .*backups/);
  assert.equal(box.json("settings.json").theme, "dark");
  assert.deepEqual(box.json("settings.json").permissions.allow, ["Bash(ls)"]);
  assert.doesNotMatch(box.run([]).stdout, /Replaced your values/);
});

test("--pull writes changes into the profile and never touches the template", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  box.run(["--profile", profile]);
  const templateBefore = fs.readFileSync(path.join(ROOT, "template", "settings.json"), "utf8");
  const settings = box.json("settings.json");
  settings.model = "fable";
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  const result = box.run(["--pull"]);
  assert.equal(result.status, 0, result.stderr);
  const pulled = JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"));
  assert.equal(pulled.model, "fable");
  assert.equal((pulled.autoMode?.environment ?? []).some((line) => line.startsWith("Host:")), false);
  assert.equal(fs.readFileSync(path.join(ROOT, "template", "settings.json"), "utf8"), templateBefore);
  const unchanged = fs.readFileSync(path.join(profile, "settings.json"), "utf8");
  box.run(["--pull"]);
  assert.equal(fs.readFileSync(path.join(profile, "settings.json"), "utf8"), unchanged, "a second pull changes nothing");
});

test("a failing profile setup.mjs is a warning, not a failure", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  fs.writeFileSync(path.join(profile, "setup.mjs"), "process.exit(3);\n");
  const result = box.run(["--profile", profile]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /setup\.mjs failed \(exit 3\)/);
});

test("unknown arguments exit with code 2", (t) => {
  const result = sandbox(t).run(["--bogus"]);
  assert.equal(result.status, 2);
});

test("a settings.json that is not valid JSON stops the install and stays untouched", (t) => {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.home, ".claude"), { recursive: true });
  const broken = '{"theme":"dark","env":{"FOO":"1"},}';
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), broken);
  const result = box.run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /settings\.json is not valid JSON/);
  assert.equal(box.read("settings.json"), broken);
});

test("a profile settings.json that is not valid JSON stops the install", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  fs.writeFileSync(path.join(profile, "settings.json"), '{"model":"opus",}');
  const result = box.run(["--profile", profile]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /setup-profile-[^\n]*settings\.json is not valid JSON/);
});

test("the install reports the detected machine", (t) => {
  const result = sandbox(t).run([]);
  assert.match(result.stdout, /Host: macOS workstation \(arm64\); Docker runs on the host; Python runs on the host\./);
});

test("a relative profile path is also found from the repository", (t) => {
  const box = sandbox(t);
  const result = box.run(["--profile", path.join("profiles", "example")], { cwd: os.tmpdir() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.realpathSync(box.json("claude-setup/config.json").profile), fs.realpathSync(path.join(ROOT, "profiles", "example")));
});

test("--pull removes a profile key the user removed after installing it", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  box.run(["--profile", profile]);
  const settings = box.json("settings.json");
  delete settings.model;
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  const result = box.run(["--pull"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal("model" in JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8")), false);
});

test("--pull keeps a profile key added since the last install", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  box.run(["--profile", profile]);
  const file = path.join(profile, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), env: { FOO: "1" } }));
  const result = box.run(["--pull"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).env, { FOO: "1" });
});

test("--pull into a profile this machine did not install stops and changes nothing", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  const before = fs.readFileSync(path.join(profile, "settings.json"), "utf8");
  box.run([]);
  const afterTemplateInstall = box.run(["--profile", profile, "--pull"]);
  assert.equal(afterTemplateInstall.status, 1);
  assert.match(afterTemplateInstall.stderr, /Run the installer with --profile/);
  assert.equal(fs.readFileSync(path.join(profile, "settings.json"), "utf8"), before, "after an install without this profile");
  assert.equal(fs.existsSync(path.join(box.home, ".claude", "claude-setup", "config.json")), false, "the failed pull does not remember the profile");
  fs.rmSync(path.join(box.home, ".claude"), { recursive: true, force: true });
  const beforeInstall = box.run(["--profile", profile, "--pull"]);
  assert.equal(beforeInstall.status, 1);
  assert.equal(fs.readFileSync(path.join(profile, "settings.json"), "utf8"), before, "before the first install");
});

test("--pull works after an install that predates installed.json", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  box.run(["--profile", profile]);
  fs.rmSync(path.join(box.home, ".claude", "claude-setup", "installed.json"));
  const settings = box.json("settings.json");
  settings.model = "fable";
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  const result = box.run(["--pull"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8")).model, "fable");
});

test("the install lists the tools found on the host", (t) => {
  const result = sandbox(t).run([]);
  assert.match(result.stdout, /Tools on the host: git, node\./);
});

const GITLAB_MAC = { ...MAC, tools: { ...MAC.tools, glab: true }, forges: [{ cli: "glab", host: "gitlab.example.com", user: "jdoe" }] };
const SOURCE = "Source control (detected on this machine): every repository on gitlab.example.com.";

test("a signed-in forge adds the source control line and a Forges line to the output", (t) => {
  const box = sandbox(t, GITLAB_MAC);
  const result = box.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Forges: glab is signed in to gitlab\.example\.com as jdoe\./);
  assert.deepEqual(box.json("settings.json").autoMode.environment, [
    "$defaults", "Host: macOS workstation (arm64); Docker runs on the host; Python runs on the host.", SOURCE,
  ]);
  assert.match(box.read("claude-setup/machine.md"), /`glab` is signed in to gitlab\.example\.com/);
});

test("autoMode entries added on this machine survive installs and stay out of the profile", (t) => {
  const box = sandbox(t, GITLAB_MAC);
  const profile = copyProfile(t);
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ model: "opus" }));
  box.run(["--profile", profile]);
  const settings = box.json("settings.json");
  settings.autoMode.environment.push("Trusted internal domains: *.example.com");
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  const pull = box.run(["--pull"]);
  assert.equal(pull.status, 0, pull.stderr);
  assert.equal("autoMode" in JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8")), false);
  const install = box.run([]);
  assert.equal(install.status, 0, install.stderr);
  assert.deepEqual(box.json("settings.json").autoMode.environment, [
    "$defaults", "Host: macOS workstation (arm64); Docker runs on the host; Python runs on the host.", SOURCE,
    "Trusted internal domains: *.example.com",
  ]);
});

test("a key the profile no longer has is removed, unless the user changed it since", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  const file = path.join(profile, "settings.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...original, env: { FOO: "1" }, outputStyle: "Explanatory" }));
  box.run(["--profile", profile]);
  const settings = box.json("settings.json");
  settings.outputStyle = "Learning";
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(file, JSON.stringify(original));
  const result = box.run([]);
  assert.equal(result.status, 0, result.stderr);
  const after = box.json("settings.json");
  assert.equal("env" in after, false);
  assert.equal(after.outputStyle, "Learning");
  assert.deepEqual(box.json("claude-setup/installed.json").values, JSON.parse(JSON.stringify(original)));
});

test("keys from an install that recorded no values are removed when the profile drops them", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  const file = path.join(profile, "settings.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...original, env: { FOO: "1" } }));
  box.run(["--profile", profile]);
  const installed = box.json("claude-setup/installed.json");
  fs.writeFileSync(path.join(box.home, ".claude", "claude-setup", "installed.json"), JSON.stringify({ profile: installed.profile, keys: installed.keys }));
  fs.writeFileSync(file, JSON.stringify(original));
  box.run([]);
  assert.equal("env" in box.json("settings.json"), false);
});

test("a permission entry an earlier install added and no layer provides any more is removed", (t) => {
  const box = sandbox(t);
  box.run([]);
  const settingsFile = path.join(box.home, ".claude", "settings.json");
  const installedFile = path.join(box.home, ".claude", "claude-setup", "installed.json");
  const settings = box.json("settings.json");
  settings.permissions.deny.push("Bash(retired *)", "Bash(mine *)");
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const installed = box.json("claude-setup/installed.json");
  installed.lists.deny.push("Bash(retired *)");
  fs.writeFileSync(installedFile, JSON.stringify(installed));
  const result = box.run([]);
  assert.equal(result.status, 0, result.stderr);
  const deny = box.json("settings.json").permissions.deny;
  assert.equal(deny.includes("Bash(retired *)"), false);
  assert.equal(deny.includes("Bash(mine *)"), true);
});

test("a team layer sits between template and profile in settings.json and CLAUDE.md", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  const team = teamLayer(t, {
    model: "sonnet",
    outputStyle: "Explanatory",
    permissions: { deny: ["Bash(team *)"] },
    autoMode: { environment: ["Team: builds run on ci.company.test"] },
    enabledPlugins: { "team-tool@team-market": true },
  });
  const result = box.run(["--profile", profile], { team });
  assert.equal(result.status, 0, result.stderr);
  const settings = box.json("settings.json");
  assert.equal(settings.model, "opus", "the profile wins over the team");
  assert.equal(settings.outputStyle, "Explanatory");
  assert.ok(settings.permissions.deny.includes("Bash(team *)"));
  assert.deepEqual(settings.autoMode.environment, ["$defaults", "Team: builds run on ci.company.test", MAC_LINE]);
  assert.equal(settings.enabledPlugins["team-tool@team-market"], true);
  assert.match(box.read("CLAUDE.md"), /begin -->\n@.*template\/CLAUDE\.md\n@.*setup-team-[^/\n]*\/CLAUDE\.md\n@.*setup-profile-[^/\n]*\/CLAUDE\.md\n@~\/\.claude\/claude-setup\/machine\.md\n/);
});

test("a relative CLAUDE_SETUP_TEAM is taken from the current folder and imported by its full path", (t) => {
  const box = sandbox(t);
  const team = teamLayer(t, { outputStyle: "Explanatory" });
  const result = box.run([], { team: path.basename(team), cwd: path.dirname(team) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.json("settings.json").outputStyle, "Explanatory");
  const line = box.read("CLAUDE.md").split("\n").find((text) => text.includes(path.basename(team)));
  assert.match(line, /^@(~\/|\/|[A-Za-z]:\/)/);
});

test("--pull keeps team entries out of the profile", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  const team = teamLayer(t, { outputStyle: "Explanatory", permissions: { deny: ["Bash(team *)"] }, enabledPlugins: { "team-tool@team-market": true } });
  box.run(["--profile", profile], { team });
  const settings = box.json("settings.json");
  settings.permissions.deny.push("Bash(mine *)");
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  const result = box.run(["--pull"], { team });
  assert.equal(result.status, 0, result.stderr);
  const pulled = JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"));
  assert.deepEqual(pulled.permissions.deny, ["Bash(mine *)"]);
  assert.equal(pulled.outputStyle, undefined);
  assert.equal(pulled.enabledPlugins["team-tool@team-market"], undefined);
});

test("a trusted-infrastructure line the team drops is removed; the user's own stays", (t) => {
  const box = sandbox(t);
  const team = teamLayer(t, { autoMode: { environment: ["Team: old.company.test is trusted"] } });
  box.run([], { team });
  const settings = box.json("settings.json");
  settings.autoMode.environment.push("Mine: staging.example.test");
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(path.join(team, "settings.json"), "{}");
  const result = box.run([], { team });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(box.json("settings.json").autoMode.environment, ["$defaults", MAC_LINE, "Mine: staging.example.test"]);
});

test("--pull leaves out a plugin the template no longer enables", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  box.run(["--profile", profile]);
  const settings = box.json("settings.json");
  settings.enabledPlugins["superpowers@claude-plugins-official"] = true;
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  const { plugins, ...installed } = box.json("claude-setup/installed.json");
  assert.ok(plugins);
  fs.writeFileSync(path.join(box.home, ".claude", "claude-setup", "installed.json"), JSON.stringify(installed));
  const result = box.run(["--pull"]);
  assert.equal(result.status, 0, result.stderr);
  const pulled = JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"));
  assert.equal(pulled.enabledPlugins?.["superpowers@claude-plugins-official"], undefined);
});

test("--pull leaves out permission entries the template dropped", (t) => {
  const box = sandbox(t);
  const profile = copyProfile(t);
  box.run(["--profile", profile]);
  const settings = box.json("settings.json");
  settings.permissions.deny.push("Bash(git push --force *)", "Bash(mine *)");
  fs.writeFileSync(path.join(box.home, ".claude", "settings.json"), JSON.stringify(settings));
  const { lists, ...installed } = box.json("claude-setup/installed.json");
  assert.ok(lists);
  fs.writeFileSync(path.join(box.home, ".claude", "claude-setup", "installed.json"), JSON.stringify(installed));
  const result = box.run(["--pull"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8")).permissions.deny, ["Bash(mine *)"]);
});

test("an install that recorded no lists had the former template's entries, and the dropped ones go", (t) => {
  const box = sandbox(t);
  box.run([]);
  const settingsFile = path.join(box.home, ".claude", "settings.json");
  const installedFile = path.join(box.home, ".claude", "claude-setup", "installed.json");
  const settings = box.json("settings.json");
  settings.permissions.deny.push("Read(.env.local)", "Bash(git push --force *)", "Bash(git push -f *)", "Bash(mine *)");
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const { lists, ...installed } = box.json("claude-setup/installed.json");
  assert.ok(lists);
  fs.writeFileSync(installedFile, JSON.stringify(installed));
  box.run([]);
  const deny = box.json("settings.json").permissions.deny;
  for (const gone of ["Read(.env.local)", "Bash(git push --force *)", "Bash(git push -f *)"]) assert.equal(deny.includes(gone), false, gone);
  assert.equal(deny.includes("Bash(mine *)"), true);
  assert.equal(deny.includes("Read(.env)"), true);
});
