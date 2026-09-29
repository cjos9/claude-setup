import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

test("the template settings are generic", () => {
  const settings = json("template/settings.json");
  assert.equal(settings.permissions.defaultMode, "auto");
  assert.deepEqual(settings.autoMode.environment, ["$defaults"]);
  assert.equal(settings.statusLine.command, 'node "${REPO}/template/statusline.mjs"');
  assert.equal(settings.model, undefined, "the model is a personal choice");
  assert.equal(settings.enabledPlugins["flow@claude-setup"], true);
  assert.equal(settings.enabledPlugins["superpowers@claude-plugins-official"], undefined, "superpowers is a profile choice");
});

test("the template leaves every decision about pushes to guard-push", () => {
  const { permissions } = json("template/settings.json");
  const rules = ["allow", "ask", "deny"].flatMap((list) => permissions[list] ?? []);
  assert.deepEqual(rules.filter((rule) => /^Bash\(git push/.test(rule)), []);
});

// A host-like word: name.tld for the top-level domains people use for code hosting and servers.
const HOST = /:\/\/|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|dev|de|eu|app|cloud|ch|at)\b/i;

test("every profile has settings, rules and a setup script, and holds preferences only", () => {
  for (const name of fs.readdirSync(path.join(ROOT, "profiles"))) {
    const settings = json(`profiles/${name}/settings.json`);
    assert.ok(fs.existsSync(path.join(ROOT, "profiles", name, "CLAUDE.md")), name);
    assert.ok(fs.existsSync(path.join(ROOT, "profiles", name, "setup.mjs")), name);
    assert.equal(settings.autoMode, undefined, `${name}: trusted infrastructure is detected per machine or belongs in a project's CLAUDE.md`);
    assert.equal(settings.modelSettings, undefined, `${name}: modelSettings is keyed by a model version; use effortLevel`);
    for (const file of ["settings.json", "CLAUDE.md"]) {
      const text = fs.readFileSync(path.join(ROOT, "profiles", name, file), "utf8");
      assert.doesNotMatch(text, HOST, `${name}/${file} names a host or URL`);
    }
  }
});

test("the repository ships only the example profile; personal profiles live in their own repository", () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "profiles")), ["example"]);
});

test("the old user folder is gone", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "user")), false);
});
