import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureMarketplace, ensurePluginMarketplaces, installMissing, isInstalled, pluginIds, refreshPlugin, windowsCommandLine,
} from "../scripts/lib/plugins.mjs";

test("the official marketplace is registered when a fresh machine does not know it yet", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    return { ok: true, stdout: "" };
  };
  const ids = ["superpowers@claude-plugins-official", "flow@claude-setup", "x@someone-else"];
  const result = ensurePluginMarketplaces({ run, known: null, ids });
  assert.deepEqual(calls, ["plugin marketplace add anthropics/claude-plugins-official"]);
  assert.deepEqual(result, { added: ["claude-plugins-official"], unknown: ["someone-else"] });
  calls.length = 0;
  ensurePluginMarketplaces({ run, known: { "claude-plugins-official": {}, "someone-else": {} }, ids });
  assert.deepEqual(calls, []);
});

function recorder(answers = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    const key = Object.keys(answers).find((prefix) => args.join(" ").startsWith(prefix));
    return key === undefined ? { ok: true, stdout: "" } : answers[key];
  };
  return { calls, run };
}

test("enabled plugins become the install list", () => {
  assert.deepEqual(pluginIds({ enabledPlugins: { "a@m": true, "b@m": false, "c@n": true } }), ["a@m", "c@n"]);
});

test("isInstalled matches whole plugin ids only", () => {
  const list = "Installed plugins:\n  ❯ flow@claude-setup\n    Version: 1\n";
  assert.equal(isInstalled(list, "flow@claude-setup"), true);
  assert.equal(isInstalled(list, "low@claude-setup"), false);
});

test("the marketplace is added when unknown, re-added when it moved, left alone otherwise", () => {
  const added = recorder();
  ensureMarketplace({ run: added.run, known: null, name: "claude-setup", dir: "C:\\setup", platform: "win32" });
  assert.deepEqual(added.calls, ["plugin marketplace add C:\\setup"]);

  const moved = recorder();
  ensureMarketplace({ run: moved.run, known: { "claude-setup": { source: { path: "C:\\old" } } }, name: "claude-setup", dir: "C:\\setup", platform: "win32" });
  assert.deepEqual(moved.calls, ["plugin marketplace remove claude-setup", "plugin marketplace add C:\\setup"]);

  const same = recorder();
  ensureMarketplace({ run: same.run, known: { "claude-setup": { source: { path: "c:\\SETUP\\" } } }, name: "claude-setup", dir: "C:\\setup", platform: "win32" });
  assert.deepEqual(same.calls, []);
});

test("only missing plugins are installed and a failure does not stop the others", () => {
  const { calls, run } = recorder({
    "plugin list": { ok: true, stdout: "  ❯ a@m\n" },
    "plugin install b@m": { ok: false, stdout: "not found" },
  });
  const result = installMissing({ run, ids: ["a@m", "b@m", "c@m"] });
  assert.deepEqual(calls, ["plugin list", "plugin install b@m --scope user", "plugin install c@m --scope user"]);
  assert.deepEqual(result, { installed: ["c@m"], failed: ["b@m"] });
});

test("refreshing reports the cached commit before and after", () => {
  const shas = ["aaaaaaa", "bbbbbbb"];
  const { calls, run } = recorder();
  const result = refreshPlugin({ run, readSha: () => shas.shift(), id: "flow@claude-setup", marketplace: "claude-setup" });
  assert.deepEqual(calls, ["plugin marketplace update claude-setup", "plugin update flow@claude-setup --scope user"]);
  assert.deepEqual(result, { before: "aaaaaaa", after: "bbbbbbb" });
});

test("on Windows every argument is quoted, so cmd.exe reads & ( ) and spaces as text", () => {
  assert.equal(
    windowsCommandLine(["claude", "plugin", "marketplace", "add", "C:\R&D (x86)\Jürgen setup"]),
    '"claude" "plugin" "marketplace" "add" "C:\R&D (x86)\Jürgen setup"',
  );
});

test("on Windows an argument cmd.exe would still interpret inside quotes is refused", () => {
  for (const arg of ['a"b', "100%", "hi!", "a\nb", "C:\dir\\"]) assert.equal(windowsCommandLine(["claude", arg]), null, arg);
});
