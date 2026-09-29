import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileRisk } from "../plugins/flow/scripts/lib/file-rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DENY = JSON.parse(fs.readFileSync(path.join(ROOT, "template", "settings.json"), "utf8")).permissions.deny;

// The template's bare-name Read rules (no path), in order: the last matching rule wins, and a
// leading ! takes the name out of the rules before it, as Claude Code's gitignore-style matching does.
const BARE_READ = /^Read\((!?)([^/~]+)\)$/;
const toRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);

function deniedByTemplate(name) {
  let denied = false;
  for (const rule of DENY) {
    const match = BARE_READ.exec(rule);
    if (match && toRegExp(match[2]).test(name)) denied = match[1] !== "!";
  }
  return denied;
}

const heldByHook = (name) => fileRisk("Read", name) !== null;

const SECRETS = [
  ".env", ".env.local", ".env.prod", ".env.ci", ".env.production.local",
  "app.key", "server.pem", "cert.pfx", "cert.p12", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
];
const NOT_SECRETS = [
  ".env.example", ".env.sample", ".env.template", ".env.dist", ".env.local.example",
  "id_rsa.pub", "id_ed25519.pub", "app.key.example", "README.md", "settings.json", "environment.ts",
];

test("the template deny rules and the protect-files hook agree on which files hold secrets", () => {
  for (const name of SECRETS) {
    assert.equal(deniedByTemplate(name), true, `deny rules miss ${name}`);
    assert.equal(heldByHook(name), true, `hook misses ${name}`);
  }
  for (const name of NOT_SECRETS) {
    assert.equal(deniedByTemplate(name), false, `deny rules block ${name}`);
    assert.equal(heldByHook(name), false, `hook blocks ${name}`);
  }
});

test("every bare deny rule of the template names files the hook also holds", () => {
  for (const rule of DENY) {
    const match = BARE_READ.exec(rule);
    if (!match || match[1] === "!") continue;
    const sample = match[2].replace(/\*/g, "x");
    assert.equal(heldByHook(sample), true, `${rule}: the hook lets ${sample} through`);
  }
});
