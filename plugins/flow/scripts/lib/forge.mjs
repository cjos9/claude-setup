// Tells which forge hosts a repository's remote, whether its CLI is signed in there and which branch
// is the default, so skills do not guess. Every probe is a command that may fail.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const KNOWN_HOSTS = { "github.com": "github", "gitlab.com": "gitlab" };
export const CLI_OF = { github: "gh", gitlab: "glab" };

function defaultRun(file, args) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// https://[user[:token]@]host[:port]/path, ssh://[user@]host[:port]/path and user@host:path. Local
// paths (C:/x, /srv/x, file://) are no forge.
export function parseRemote(url) {
  const text = url.trim();
  if (/^[A-Za-z]:[\\/]/.test(text)) return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:@]+)(?::\d*)?\/(.+)$/i.exec(text) ?? /^(?:[^@/:]+@)?([^/:@]+):(?!\/)(.+)$/.exec(text);
  if (!match) return null;
  return { host: match[1].toLowerCase(), project: match[2].replace(/\/+$/, "").replace(/\.git$/, "") };
}

export function forgeKind(host, { hasFile = () => false } = {}) {
  if (!host) return "unknown";
  if (Object.hasOwn(KNOWN_HOSTS, host)) return KNOWN_HOSTS[host];
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("github")) return "github";
  return hasFile(".gitlab-ci.yml") ? "gitlab" : "unknown";
}

// `git ls-remote --symref <remote> HEAD` prints "ref: refs/heads/<branch>\tHEAD".
export function parseSymref(output) {
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output)?.[1] ?? null;
}

// gh: "Logged in to <host> account <user>", glab: "Logged in to <host> as <user>".
export function signedIn(output, host) {
  return [...output.matchAll(/Logged in to (\S+) (?:account|as) /g)].some(([, name]) => name.toLowerCase() === host);
}

// The current branch's upstream remote, else origin, else the first remote.
function pickRemote(git) {
  const remotes = git("remote").stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  const fromUpstream = upstream.ok ? remotes.find((name) => upstream.stdout.trim().startsWith(`${name}/`)) : undefined;
  return fromUpstream ?? (remotes.includes("origin") ? "origin" : remotes[0] ?? null);
}

function defaultBranch(git, remote) {
  const local = git("symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`);
  const ref = local.ok ? local.stdout.trim() : "";
  if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
  const advertised = git("ls-remote", "--symref", remote, "HEAD");
  return advertised.ok ? parseSymref(advertised.stdout) : null;
}

export function describeRepo(cwd, { run = defaultRun, exists = fs.existsSync } = {}) {
  const none = { remote: null, host: null, project: null, kind: "unknown", cli: null, defaultBranch: null };
  const git = (...args) => run("git", ["-C", cwd, ...args]);
  const top = git("rev-parse", "--show-toplevel");
  if (!top.ok) return none;
  const root = top.stdout.trim();
  const remote = pickRemote(git);
  if (!remote) return none;
  const url = git("remote", "get-url", remote);
  const parsed = url.ok ? parseRemote(url.stdout) : null;
  let kind = forgeKind(parsed?.host, { hasFile: (name) => exists(path.join(root, name)) });
  let cli = null;
  // A host whose name tells nothing is the forge whose CLI is signed in there.
  const candidates = !parsed ? [] : Object.hasOwn(CLI_OF, kind) ? [kind] : ["gitlab", "github"];
  for (const candidate of candidates) {
    const auth = run(CLI_OF[candidate], ["auth", "status", "--hostname", parsed.host]);
    if (signedIn(`${auth.stdout}\n${auth.stderr}`, parsed.host)) {
      kind = candidate;
      cli = CLI_OF[candidate];
      break;
    }
  }
  return {
    remote,
    host: parsed?.host ?? null,
    project: parsed?.project ?? null,
    kind,
    cli,
    defaultBranch: defaultBranch(git, remote),
  };
}
