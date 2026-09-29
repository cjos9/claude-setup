// Decides whether a file tool call touches secrets or files that only their own tools may write.

const TEMPLATE = /\.(example|sample|template|dist)$/i;
const SECRETS = [/^\.env$/i, /^\.env\..+$/i, /\.(pfx|p12|key|pem)$/i];
const SSH_KEY_START = /^id_(rsa|ed25519|ecdsa|dsa)/i;
const LOCKFILES = new Set(["packages.lock.json", "uv.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
const SOPS = /\.(sops|enc)\.[^.]+$/i;
const WRITING_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

export function fileRisk(toolName, filePath) {
  if (typeof filePath !== "string" || filePath === "") return null;
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);

  if (!TEMPLATE.test(name) && (
    SECRETS.some((pattern) => pattern.test(name)) ||
    (SSH_KEY_START.test(name) && !/\.pub$/i.test(name))
  )) {
    return `${name} holds secrets and stays out of Claude's context. Ask the user for the value you need instead.`;
  }
  if (!WRITING_TOOLS.has(toolName)) return null;
  if (/(^|\/)\.git\//i.test(normalized)) return "files under .git/ belong to git. Use git commands instead.";
  if (LOCKFILES.has(name.toLowerCase())) {
    return `${name} is generated. Change dependencies with the package manager (dotnet, uv, npm) instead.`;
  }
  if (SOPS.test(name)) return `${name} is sops-encrypted. Edit it with 'sops' so its MAC stays valid.`;
  return null;
}
