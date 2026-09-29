// Plugin steps through the `claude` CLI. `run(args)` returns { ok, stdout }; nothing here throws on
// a failed command, the installer reports it.
import path from "node:path";

export function pluginIds(settings) {
  return Object.entries(settings.enabledPlugins ?? {}).filter(([, enabled]) => enabled).map(([id]) => id);
}

export function isInstalled(listOutput, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "m").test(listOutput);
}

const samePath = (a, b, platform) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "");
  return platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

export function ensureMarketplace({ run, known, name, dir, platform = process.platform }) {
  const registered = known?.[name]?.source?.path;
  if (registered && samePath(registered, dir, platform)) return "current";
  if (registered) run(["plugin", "marketplace", "remove", name]);
  run(["plugin", "marketplace", "add", dir]);
  return registered ? "moved" : "added";
}

// A fresh machine may not know the marketplaces the enabled plugins come from. The official one is
// added from its GitHub repo; others cannot be guessed and are returned so the installer can warn.
const KNOWN_SOURCES = { "claude-plugins-official": "anthropics/claude-plugins-official" };

export function ensurePluginMarketplaces({ run, known, ids, skip = ["claude-setup"] }) {
  const result = { added: [], unknown: [] };
  const needed = [...new Set(ids.map((id) => id.split("@")[1]).filter(Boolean))];
  for (const name of needed) {
    if (skip.includes(name) || known?.[name]) continue;
    if (KNOWN_SOURCES[name] && run(["plugin", "marketplace", "add", KNOWN_SOURCES[name]]).ok) result.added.push(name);
    else result.unknown.push(name);
  }
  return result;
}

export function installMissing({ run, ids }) {
  const list = run(["plugin", "list"]).stdout;
  const result = { installed: [], failed: [] };
  for (const id of ids) {
    if (isInstalled(list, id)) continue;
    (run(["plugin", "install", id, "--scope", "user"]).ok ? result.installed : result.failed).push(id);
  }
  return result;
}

// Claude Code runs plugins from a copy in its cache; refreshing takes the repo's current commit.
export function refreshPlugin({ run, readSha, id, marketplace }) {
  const before = readSha();
  run(["plugin", "marketplace", "update", marketplace]);
  run(["plugin", "update", id, "--scope", "user"]);
  return { before, after: readSha() };
}
