import test from "node:test";
import assert from "node:assert/strict";
import {
  changedKeys, dropStaleListEntries, dropStaleProfileKeys, keepOwnAutoMode, layerSettings, managedLists, mergeIntoUser,
  pullToProfile, replacedValues, resolvePlaceholders, unresolvePlaceholders,
} from "../scripts/lib/settings.mjs";

const template = {
  $schema: "s",
  statusLine: { type: "command", command: 'node "${REPO}/template/statusline.mjs"' },
  permissions: { defaultMode: "auto", deny: ["Read(.env)", "Read(*.key)"] },
  autoMode: { environment: ["$defaults"] },
  enabledPlugins: { "flow@claude-setup": true, "superpowers@claude-plugins-official": true },
};
const profile = {
  model: "opus[1m]",
  permissions: { deny: ["Read(secrets/**)"] },
  autoMode: { environment: ["Source control: github.com/me"] },
  enabledPlugins: { "csharp-lsp@claude-plugins-official": true },
};
const HOST = "Host: macOS workstation (arm64); Docker runs on the host; Python runs on the host.";

test("the profile layers over the template and the machine line comes last", () => {
  const managed = layerSettings(template, profile, HOST);
  assert.equal(managed.model, "opus[1m]");
  assert.deepEqual(managed.permissions, { defaultMode: "auto", deny: ["Read(.env)", "Read(*.key)", "Read(secrets/**)"] });
  assert.deepEqual(managed.autoMode.environment, ["$defaults", "Source control: github.com/me", HOST]);
  assert.deepEqual(Object.keys(managed.enabledPlugins), [
    "flow@claude-setup", "superpowers@claude-plugins-official", "csharp-lsp@claude-plugins-official",
  ]);
  assert.deepEqual(template.autoMode.environment, ["$defaults"], "the template is not mutated");
});

test("without a profile or machine line the template comes through unchanged", () => {
  assert.deepEqual(layerSettings(template), template);
});

test("placeholders resolve to forward-slash paths, spaces included, and round-trip", () => {
  const vars = { REPO: "C:\\Users\\A B\\claude-setup", PROFILE: null };
  const resolved = resolvePlaceholders(template.statusLine, vars);
  assert.equal(resolved.command, 'node "C:/Users/A B/claude-setup/template/statusline.mjs"');
  assert.deepEqual(unresolvePlaceholders(resolved, vars), template.statusLine);
});

test("merging into the user's settings keeps unknown keys and replaces autoMode as a whole", () => {
  const user = {
    theme: "dark",
    permissions: { deny: ["Bash(rm -rf *)"] },
    autoMode: { environment: ["$defaults", "Host containment: Windows 11 workstation with WSL2 Ubuntu"] },
  };
  const merged = mergeIntoUser(user, layerSettings(template, profile, HOST));
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.permissions.deny, ["Bash(rm -rf *)", "Read(.env)", "Read(*.key)", "Read(secrets/**)"]);
  assert.deepEqual(merged.autoMode.environment, ["$defaults", "Source control: github.com/me", HOST]);
});

test("merging twice changes nothing", () => {
  const managed = layerSettings(template, profile, HOST);
  const once = mergeIntoUser({ theme: "dark" }, managed);
  assert.deepEqual(changedKeys(once, mergeIntoUser(once, managed)), []);
});

test("pull writes the user's changes into the profile, never template entries or autoMode", () => {
  const user = mergeIntoUser({}, layerSettings(template, profile, HOST));
  user.model = "fable";
  user.permissions.deny = user.permissions.deny.filter((rule) => rule !== "Read(secrets/**)").concat("Read(*.pem)");
  user.autoMode.environment = [...user.autoMode.environment, "Sensitive: my server"];
  user.enabledPlugins["context7@claude-plugins-official"] = true;
  const pulled = pullToProfile(user, template, profile, HOST);
  assert.equal(pulled.model, "fable");
  assert.deepEqual(pulled.permissions.deny, ["Read(*.pem)"]);
  assert.deepEqual(pulled.autoMode, profile.autoMode, "autoMode entries stay on the machine they were added on");
  assert.deepEqual(pulled.enabledPlugins, {
    "csharp-lsp@claude-plugins-official": true, "context7@claude-plugins-official": true,
  });
});

test("pull without changes returns the profile unchanged", () => {
  const user = mergeIntoUser({ theme: "dark" }, layerSettings(template, profile, HOST));
  assert.deepEqual(pullToProfile(user, template, profile, HOST), profile);
});

test("pull without machine facts still leaves the machine line out of the profile", () => {
  const user = mergeIntoUser({}, layerSettings(template, profile, HOST));
  const pulled = pullToProfile(user, template, profile, null);
  assert.deepEqual(pulled.autoMode.environment, ["Source control: github.com/me"]);
});

test("a profile key the user removed after it was installed is removed from the profile", () => {
  const user = mergeIntoUser({}, layerSettings(template, profile, HOST));
  delete user.model;
  delete user.statusLine;
  const pulled = pullToProfile(user, template, profile, HOST, Object.keys(profile));
  assert.equal("model" in pulled, false);
  assert.equal("statusLine" in pulled, false, "a template key is never written into the profile");
});

test("a profile key this machine never installed stays in the profile", () => {
  const user = mergeIntoUser({}, layerSettings(template, profile, HOST));
  const withEnv = { ...profile, env: { FOO: "1" } };
  const pulled = pullToProfile(user, template, withEnv, HOST, Object.keys(profile));
  assert.deepEqual(pulled.env, { FOO: "1" });
  assert.equal(pullToProfile(user, template, withEnv, HOST).env.FOO, "1", "without a record nothing is removed");
});

test("unresolving leaves a sibling folder that shares the prefix alone", () => {
  assert.deepEqual(
    unresolvePlaceholders({ a: "node C:/x/setup-old/hook.mjs", b: "cd \"C:/x/setup\"" }, { REPO: "C:/x/setup" }),
    { a: "node C:/x/setup-old/hook.mjs", b: "cd \"${REPO}\"" },
  );
});

test("paths inside a profile in the repository unresolve to PROFILE, not REPO", () => {
  const vars = { REPO: "C:\\r\\setup", PROFILE: "C:\\r\\setup\\profiles\\me" };
  assert.deepEqual(
    unresolvePlaceholders({ a: "node C:/r/setup/profiles/me/hook.mjs", b: "node C:/r/setup/template/s.mjs" }, vars),
    { a: "node ${PROFILE}/hook.mjs", b: "node ${REPO}/template/s.mjs" },
  );
});

test("several machine lines come last, in order", () => {
  const SOURCE = "Source control (detected on this machine): every repository on gitlab.example.com.";
  const managed = layerSettings(template, {}, [HOST, SOURCE]);
  assert.deepEqual(managed.autoMode.environment, ["$defaults", HOST, SOURCE]);
  const user = mergeIntoUser({}, managed);
  user.autoMode.environment.push("Trusted internal domains: *.example.com");
  assert.equal(pullToProfile(user, template, {}, [HOST, SOURCE]).autoMode, undefined);
});

test("the user's own autoMode entries survive an install; generated and formerly installed ones do not", () => {
  const managed = layerSettings(template, {}, [HOST]);
  const user = {
    autoMode: {
      environment: ["$defaults", "Host: Windows workstation (x64); Docker is not installed; Python is not installed.", "Old profile line", "Trusted internal domains: *.example.com"],
      allow: ["$defaults", "Deploying to staging is allowed"],
      classifyAllShell: true,
    },
  };
  const previous = { keys: ["autoMode"], values: { autoMode: { environment: ["Old profile line"] } } };
  assert.deepEqual(keepOwnAutoMode(user, managed, previous).autoMode, {
    environment: ["$defaults", HOST, "Trusted internal domains: *.example.com"],
    allow: ["$defaults", "Deploying to staging is allowed"],
    classifyAllShell: true,
  });
  assert.deepEqual(keepOwnAutoMode(user, managed, { keys: ["autoMode"] }), managed, "installs that recorded no values replace autoMode");
  assert.deepEqual(keepOwnAutoMode(user, managed, null), managed);
  assert.deepEqual(keepOwnAutoMode({}, managed, previous), managed);
});

test("a team layer sits between template and profile", () => {
  const team = { model: "sonnet", outputStyle: "Explanatory", permissions: { deny: ["Bash(team *)"] }, autoMode: { environment: ["Team line"] } };
  const managed = layerSettings(layerSettings(template, team), profile, HOST);
  assert.equal(managed.model, "opus[1m]");
  assert.equal(managed.outputStyle, "Explanatory");
  assert.deepEqual(managed.permissions.deny, ["Read(.env)", "Read(*.key)", "Bash(team *)", "Read(secrets/**)"]);
  assert.deepEqual(managed.autoMode.environment, ["$defaults", "Team line", "Source control: github.com/me", HOST]);
});

test("autoMode entries the last install managed, also from a team, do not count as the user's own", () => {
  const managed = layerSettings(template, {}, [HOST]);
  const user = { autoMode: { environment: ["$defaults", HOST, "Team: old.company.test is trusted", "Mine"] } };
  const previous = { keys: [], values: {}, autoMode: { environment: ["$defaults", "Team: old.company.test is trusted", HOST] } };
  assert.deepEqual(keepOwnAutoMode(user, managed, previous).autoMode.environment, ["$defaults", HOST, "Mine"]);
});

test("a key the profile dropped is removed unless the user changed it since", () => {
  const managed = { model: "opus" };
  const previous = { keys: ["model", "env", "effortLevel"], values: { model: "opus", env: { A: "1" }, effortLevel: "high" } };
  const user = { model: "opus", env: { A: "1" }, effortLevel: "max", theme: "dark" };
  assert.deepEqual(dropStaleProfileKeys(user, previous, managed), { model: "opus", effortLevel: "max", theme: "dark" });
  assert.deepEqual(dropStaleProfileKeys(user, { keys: ["effortLevel"] }, managed), { model: "opus", env: { A: "1" }, theme: "dark" }, "without recorded values");
  assert.deepEqual(dropStaleProfileKeys(user, null, managed), user);
});

test("permission entries an earlier install added and no layer manages any more are removed; the user's own stay", () => {
  const user = { model: "x", permissions: { defaultMode: "auto", deny: ["Read(.env)", "Bash(old *)", "Bash(mine *)"], allow: ["Bash(npm test)"] } };
  const managed = { permissions: { deny: ["Read(.env)"] } };
  assert.deepEqual(dropStaleListEntries(user, { deny: ["Read(.env)", "Bash(old *)"] }, managed), {
    model: "x", permissions: { defaultMode: "auto", deny: ["Read(.env)", "Bash(mine *)"], allow: ["Bash(npm test)"] },
  });
  assert.deepEqual(dropStaleListEntries(user, null, managed), user, "nothing recorded, nothing removed");
  assert.deepEqual(dropStaleListEntries({ model: "x" }, { deny: ["Bash(old *)"] }, managed), { model: "x" });
});

test("--pull does not take a plugin the last install enabled from the template for the user's choice", () => {
  const user = { enabledPlugins: { "flow@claude-setup": true, "superpowers@claude-plugins-official": true, "mine@x": true } };
  const base = { enabledPlugins: { "flow@claude-setup": true } };
  const previousPlugins = { "flow@claude-setup": true, "superpowers@claude-plugins-official": true };
  assert.deepEqual(pullToProfile(user, base, {}, [], [], previousPlugins).enabledPlugins, { "mine@x": true });
  const withProfile = { enabledPlugins: { "superpowers@claude-plugins-official": true } };
  assert.deepEqual(pullToProfile(user, base, withProfile, [], [], previousPlugins).enabledPlugins, {
    "superpowers@claude-plugins-official": true, "mine@x": true,
  });
});

test("the managed permission lists are recorded for the next install", () => {
  assert.deepEqual(managedLists(layerSettings(template, profile)), { deny: ["Read(.env)", "Read(*.key)", "Read(secrets/**)"] });
  assert.deepEqual(managedLists({ model: "x" }), {});
});

test("replacedValues names changed scalars and lists that lost entries, not lists that only grew", () => {
  const user = {
    theme: "dark", model: "sonnet",
    permissions: { defaultMode: "default", allow: ["Bash(ls)"] },
    hooks: { PreToolUse: [{ matcher: "Bash" }] },
  };
  const next = {
    theme: "dark", model: "opus",
    permissions: { defaultMode: "auto", allow: ["Bash(ls)", "Bash(git status)"] },
    hooks: { Stop: [{ matcher: "" }] },
  };
  assert.deepEqual(replacedValues(user, next), ["model", "permissions.defaultMode", "hooks.PreToolUse"]);
});
