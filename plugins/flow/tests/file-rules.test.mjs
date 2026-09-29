import test from "node:test";
import assert from "node:assert/strict";
import { fileRisk } from "../scripts/lib/file-rules.mjs";

test("env files are off limits for reading and writing", () => {
  for (const file of [".env", "C:\\repo\\.env.local", "/c/repo/.env.production", "app/.env.test"]) {
    assert.match(fileRisk("Read", file), /secrets/, file);
    assert.match(fileRisk("Edit", file), /secrets/, file);
  }
});

test("env templates stay readable", () => {
  for (const file of [".env.example", "C:\\repo\\.env.production.example", ".env.sample", ".env.template"]) {
    assert.equal(fileRisk("Read", file), null, file);
  }
  assert.equal(fileRisk("Read", ".envrc"), null);
});

test("keys and certificates are off limits", () => {
  for (const file of ["cert.pfx", "C:\\certs\\client.p12", "server.key", "tls.pem", "C:\\Users\\me\\.ssh\\id_ed25519", "id_rsa"]) {
    assert.match(fileRisk("Read", file), /secrets/, file);
  }
  assert.equal(fileRisk("Read", "id_ed25519.pub"), null);
});

test("git internals, lockfiles and sops files can be read but not written", () => {
  const cases = [
    ["C:\\repo\\.git\\config", /git commands/],
    ["uv.lock", /package manager/],
    ["src/packages.lock.json", /package manager/],
    ["package-lock.json", /package manager/],
    ["secrets.sops.yaml", /sops/],
    ["vault.enc.json", /sops/],
  ];
  for (const [file, reason] of cases) {
    assert.equal(fileRisk("Read", file), null, file);
    assert.match(fileRisk("Write", file), reason, file);
    assert.match(fileRisk("Edit", file), reason, file);
  }
});

test(".git check is case-insensitive (NTFS bypass)", () => {
  for (const file of ["C:\\repo\\.GIT\\config", "C:\\repo\\.Git\\HEAD"]) {
    assert.match(fileRisk("Edit", file), /git commands/, file);
    assert.match(fileRisk("Write", file), /git commands/, file);
    assert.equal(fileRisk("Read", file), null, file);
  }
});

test("SSH key prefix matching and .pub exceptions", () => {
  for (const file of ["id_rsa.bak", "id_rsa_old", "id_rsa2", "C:\\Users\\me\\.ssh\\id_ed25519-backup", "ID_RSA"]) {
    assert.match(fileRisk("Read", file), /secrets/, file);
  }
  for (const file of ["id_rsa.pub", "id_ed25519.pub", "ID_RSA.PUB"]) {
    assert.equal(fileRisk("Read", file), null, file);
  }
});

test("ordinary files and missing paths pass", () => {
  assert.equal(fileRisk("Edit", "src/App/Result.cs"), null);
  assert.equal(fileRisk("Write", "C:\\repo\\README.md"), null);
  assert.equal(fileRisk("Read", undefined), null);
  assert.equal(fileRisk("Read", ""), null);
});

test(".dist templates stay readable and MultiEdit counts as writing", () => {
  assert.equal(fileRisk("Read", ".env.dist"), null);
  assert.equal(fileRisk("Read", "C:\repo\config\.env.local.dist"), null);
  assert.match(fileRisk("MultiEdit", ".env"), /secrets/);
  assert.match(fileRisk("MultiEdit", "package-lock.json"), /package manager/);
  assert.equal(fileRisk("Glob", "package-lock.json"), null);
});
