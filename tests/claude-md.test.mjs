import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BEGIN, END, importLine, importTarget, updateManagedBlock } from "../scripts/lib/claude-md.mjs";

test("imports under the home directory use ~ and forward slashes", () => {
  assert.equal(importLine("C:\\Users\\me\\dev\\setup\\template\\CLAUDE.md", "C:\\Users\\me"), "@~/dev/setup/template/CLAUDE.md");
  assert.equal(importLine("/Users/me/dev/setup/template/CLAUDE.md", "/Users/me"), "@~/dev/setup/template/CLAUDE.md");
  assert.equal(importLine("D:\\work\\setup\\CLAUDE.md", "C:\\Users\\me"), "@D:/work/setup/CLAUDE.md");
});

test("a path with whitespace is imported through a copy in the state directory", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude md "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(source, "# rules\n");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "state-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const target = importTarget(source, state, "profile.md");
  assert.equal(target, path.join(state, "profile.md"));
  assert.equal(fs.readFileSync(target, "utf8"), "# rules\n");
  assert.equal(importTarget(path.join(state, "profile.md"), state, "x.md"), path.join(state, "profile.md"));
});

test("the managed block is added once, kept in place and updated", () => {
  const first = updateManagedBlock("# My notes\n", ["@~/a.md"]);
  assert.equal(first, `${BEGIN}\n@~/a.md\n${END}\n\n# My notes\n`);
  const second = updateManagedBlock(first, ["@~/a.md", "@~/b.md"]);
  assert.equal(second, `${BEGIN}\n@~/a.md\n@~/b.md\n${END}\n\n# My notes\n`);
  assert.equal(updateManagedBlock(second, ["@~/a.md", "@~/b.md"]), second);
});

test("the old installer's single import line is removed", () => {
  const legacy = "@~/dev/claude-setup/user/CLAUDE.md\n";
  assert.equal(updateManagedBlock(legacy, ["@~/x.md"]), `${BEGIN}\n@~/x.md\n${END}\n`);
});

test("a stray end marker before the block leaves exactly one block", () => {
  const count = (text, marker) => text.split(marker).length - 1;
  for (const text of [`${END}\n# notes\n${BEGIN}\n@~/old.md\n${END}\n`, `${END}\n# notes\n${BEGIN}\n@~/old.md\n`]) {
    const next = updateManagedBlock(text, ["@~/new.md"]);
    assert.equal(count(next, BEGIN), 1, next);
    assert.equal(count(next, END), 1, next);
    assert.ok(next.includes(`${BEGIN}\n@~/new.md\n${END}`), next);
    assert.match(next, /# notes/);
    assert.equal(updateManagedBlock(next, ["@~/new.md"]), next);
  }
});

test("a second complete block is removed with its imports", () => {
  const damaged = `${BEGIN}\n@~/new.md\n${END}\n\n${END}\n# notes\n${BEGIN}\n@~/old.md\n${END}\n`;
  assert.equal(updateManagedBlock(damaged, ["@~/new.md"]), `${BEGIN}\n@~/new.md\n${END}\n\n# notes\n`);
});

test("an unclosed begin marker above the block keeps the text below it", () => {
  const text = `${BEGIN}\n# my notes\n${BEGIN}\n@~/old.md\n${END}\n`;
  assert.equal(updateManagedBlock(text, ["@~/new.md"]), `# my notes\n${BEGIN}\n@~/new.md\n${END}\n`);
});
