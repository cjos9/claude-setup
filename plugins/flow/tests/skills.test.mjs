import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = (name) => fs.readFileSync(path.join(PLUGIN, "skills", name, "SKILL.md"), "utf8");

test("skills call scripts that exist", () => {
  for (const name of ["ship", "setup-project"]) {
    const scripts = [...skill(name).matchAll(/\$\{CLAUDE_SKILL_DIR\}\/\.\.\/\.\.\/scripts\/([\w-]+\.mjs)/g)].map(([, file]) => file);
    assert.ok(scripts.includes("forge.mjs"), `${name} asks forge.mjs`);
    for (const file of scripts) assert.ok(fs.existsSync(path.join(PLUGIN, "scripts", file)), `${name}: ${file}`);
  }
});

test("ship covers GitHub, GitLab with and without glab, and other forges, and never merges", () => {
  const text = skill("ship");
  for (const needle of ["gh pr create", "glab mr create", "merge_request.create", "Never merge"]) assert.ok(text.includes(needle), needle);
  assert.doesNotMatch(text, /-o merge_request\.(auto_merge|merge_when_pipeline_succeeds)/);
});

test("flow skills work without superpowers and use its skills only when available", () => {
  for (const name of ["ship", "setup-project", "wsl"]) {
    for (const line of skill(name).split("\n").filter((text) => text.includes("superpowers:"))) {
      assert.match(line, /superpowers:[\w-]+ if it is available/, `${name}: ${line}`);
    }
  }
});

test("setup-project reads the CI of any forge", () => {
  const text = skill("setup-project");
  for (const needle of [".github/workflows", ".gitlab-ci.yml"]) assert.ok(text.includes(needle), needle);
});

test("ship sets a project without flow.json up through setup-project's steps, in a commit of its own", () => {
  const text = skill("ship");
  const reference = /\$\{CLAUDE_SKILL_DIR\}\/\.\.\/(setup-project)\/SKILL\.md/.exec(text);
  assert.ok(reference, "ship points to setup-project's SKILL.md");
  assert.ok(fs.existsSync(path.join(PLUGIN, "skills", reference[1], "SKILL.md")));
  const steps = /steps (\d) to (\d)/.exec(text);
  assert.ok(steps, "ship names the setup steps it follows");
  const headings = [...skill("setup-project").matchAll(/^## (\d)\. (.+)$/gm)].map(([, number, title]) => [Number(number), title]);
  const followed = headings.filter(([number]) => number >= Number(steps[1]) && number <= Number(steps[2])).map(([, title]) => title);
  assert.deepEqual(followed, ["Learn the project", "Write CLAUDE.md", "Write .claude/settings.json and .claude/flow.json", "Ignore local files"]);
  assert.ok(text.includes("chore: set up Claude Code"), "the setup gets its own commit");
});

test("setup-project's .NET stack warns that Microsoft.Testing.Platform needs its own dotnet test mode", () => {
  const stacks = fs.readFileSync(path.join(PLUGIN, "skills", "setup-project", "stacks.md"), "utf8");
  const dotnet = stacks.slice(stacks.indexOf("## .NET"), stacks.indexOf("## Python"));
  for (const needle of ["Microsoft.Testing.Platform", "global.json", "TestingPlatformDotnetTestSupport"]) assert.ok(dotnet.includes(needle), needle);
});
