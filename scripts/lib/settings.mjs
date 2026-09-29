// Layers the template, a profile and the machine lines into the managed settings, merges them into
// the user's settings.json, and pulls changes made inside Claude Code back into the profile.
import { isMachineLine } from "./machine.mjs";

export const UNION_LISTS = ["allow", "deny", "ask", "additionalDirectories"];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const union = (first = [], second = []) => [...first, ...second.filter((item) => !first.includes(item))];

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = new Set(Object.keys(b));
  if (keysA.length !== keysB.size) return false;
  return keysA.every((key) => keysB.has(key) && deepEqual(a[key], b[key]));
}

const posix = (dir) => dir.replace(/\\/g, "/");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function resolvePlaceholders(value, vars) {
  let json = JSON.stringify(value);
  for (const [name, dir] of Object.entries(vars)) if (dir) json = json.replaceAll(`\${${name}}`, posix(dir));
  return JSON.parse(json);
}

// Longest path first, so a profile inside the repository becomes ${PROFILE}, not ${REPO}/profiles/...;
// a path counts only as a whole folder name, so C:/x/setup-old stays as it is.
export function unresolvePlaceholders(value, vars) {
  let json = JSON.stringify(value);
  const byLength = Object.entries(vars).filter(([, dir]) => dir).sort(([, a], [, b]) => b.length - a.length);
  for (const [name, dir] of byLength) {
    json = json.replace(new RegExp(`${escapeRegExp(posix(dir))}(?![\\w.-])`, "g"), () => `\${${name}}`);
  }
  return JSON.parse(json);
}

// template, then profile, then the machine lines: profile scalars win, permission lists and
// autoMode.environment are unions, enabledPlugins merge key by key, other objects merge shallowly.
export function layerSettings(template, profile = {}, machineLines = []) {
  const result = { ...template };
  for (const [key, value] of Object.entries(profile)) {
    if (key === "permissions") {
      const permissions = { ...(template.permissions ?? {}), ...value };
      for (const list of UNION_LISTS) {
        if (template.permissions?.[list] || value[list]) permissions[list] = union(template.permissions?.[list], value[list]);
      }
      result.permissions = permissions;
    } else if (key === "autoMode") {
      result.autoMode = {
        ...(template.autoMode ?? {}),
        ...value,
        environment: union(template.autoMode?.environment, value.environment),
      };
    } else if (isObject(value) && isObject(template[key])) {
      result[key] = { ...template[key], ...value };
    } else {
      result[key] = value;
    }
  }
  const lines = [machineLines].flat().filter(Boolean);
  if (lines.length > 0) {
    result.autoMode = { ...(result.autoMode ?? {}), environment: [...(result.autoMode?.environment ?? []), ...lines] };
  }
  return result;
}

// Managed keys win (autoMode is replaced as a whole); unknown user keys stay; permission lists are
// unions with the user's own entries; enabledPlugins merge key by key.
export function mergeIntoUser(user, managed) {
  const result = { ...user };
  for (const [key, value] of Object.entries(managed)) {
    if (key === "permissions") {
      const permissions = { ...(user.permissions ?? {}), ...value };
      for (const list of UNION_LISTS) {
        if (value[list] || user.permissions?.[list]) permissions[list] = union(user.permissions?.[list], value[list]);
      }
      result.permissions = permissions;
    } else if (key === "enabledPlugins") {
      result.enabledPlugins = { ...(user.enabledPlugins ?? {}), ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

// Keeps the profile's order, drops what the user removed, appends what the user added; entries the
// template provides never go into the profile.
function pullList(userList = [], templateList = [], profileList = []) {
  const own = userList.filter((item) => !templateList.includes(item));
  return union(profileList.filter((item) => own.includes(item)), own);
}

function pullPermissions(user = {}, template = {}, profile = {}) {
  const result = { ...profile };
  for (const [key, value] of Object.entries(user)) {
    if (UNION_LISTS.includes(key)) {
      const list = pullList(value, template[key], profile[key]);
      if (list.length > 0 || profile[key]) result[key] = list;
    } else if (!deepEqual(value, profile[key] ?? template[key])) {
      result[key] = value;
    }
  }
  return result;
}

// installedKeys: the profile keys the last install put into settings.json. A key missing there was
// removed by the user (e.g. /model Default) only if it was installed; otherwise it stays. autoMode
// is never pulled: trusted infrastructure stays on the machine it was added on (see keepOwnAutoMode).
// previousPlugins: the enabledPlugins the last install put into settings.json; a plugin it enabled
// from the template or a team, and not from the profile, is not the user's choice.
export function pullToProfile(user, template, profile = {}, machineLines = [], installedKeys = [], previousPlugins = {}) {
  const managed = layerSettings(template, profile, machineLines);
  const next = { ...profile };
  for (const key of Object.keys(managed)) {
    if (key === "$schema" || key === "autoMode" || deepEqual(user[key], managed[key])) continue;
    if (!(key in user)) {
      if (installedKeys.includes(key)) delete next[key];
      continue;
    }
    if (key === "permissions") {
      next.permissions = pullPermissions(user.permissions, template.permissions, profile.permissions);
    } else if (key === "enabledPlugins") {
      const installedBefore = (id, on) => previousPlugins[id] === on && profile.enabledPlugins?.[id] === undefined;
      const own = Object.entries(user.enabledPlugins ?? {}).filter(([id, on]) => template.enabledPlugins?.[id] !== on && !installedBefore(id, on));
      next.enabledPlugins = Object.fromEntries(own);
    } else {
      next[key] = user[key];
    }
  }
  return next;
}

const AUTO_MODE_LISTS = ["environment", "allow", "soft_deny", "hard_deny"];

// The user's own autoMode entries (added with /permissions or /auto-mode-setup) stay on this machine:
// every list keeps the entries that are neither managed, generated for the machine, nor installed by
// the last install (its recorded autoMode, or the profile's for installs that recorded none). Installs
// that recorded no values replace autoMode as a whole.
export function keepOwnAutoMode(user, managed, previous) {
  if (!previous?.values || !isObject(user.autoMode)) return managed;
  const installed = previous.autoMode ?? previous.values.autoMode ?? {};
  const autoMode = { ...user.autoMode, ...(managed.autoMode ?? {}) };
  for (const list of AUTO_MODE_LISTS) {
    const managedList = managed.autoMode?.[list] ?? [];
    const own = (Array.isArray(user.autoMode[list]) ? user.autoMode[list] : [])
      .filter((entry) => !managedList.includes(entry) && !(installed[list] ?? []).includes(entry) && !isMachineLine(entry));
    const merged = [...managedList, ...own];
    if (merged.length > 0) autoMode[list] = merged;
    else delete autoMode[list];
  }
  return { ...managed, autoMode };
}

export function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !deepEqual(before[key], after[key]));
}

// The permission lists of the managed settings, recorded in installed.json for dropStaleListEntries.
export function managedLists(managed) {
  return Object.fromEntries(UNION_LISTS.filter((list) => managed.permissions?.[list]).map((list) => [list, managed.permissions[list]]));
}

// previousLists: the lists the last install put into settings.json. An entry from there that no layer
// manages any more is removed; entries the user added stay.
export function dropStaleListEntries(user, previousLists, managed) {
  if (!previousLists || !isObject(user.permissions)) return user;
  const permissions = { ...user.permissions };
  for (const list of UNION_LISTS) {
    if (!Array.isArray(permissions[list])) continue;
    const before = previousLists[list] ?? [];
    const now = managed.permissions?.[list] ?? [];
    permissions[list] = permissions[list].filter((entry) => !before.includes(entry) || now.includes(entry));
  }
  return { ...user, permissions };
}

// previous: installed.json of the last install. A key it took from a profile that no layer provides
// any more is removed, unless the user changed its value since; installs that recorded no values
// count as unchanged.
export function dropStaleProfileKeys(user, previous, managed) {
  const result = { ...user };
  const keys = Array.isArray(previous?.keys) ? previous.keys : [];
  for (const key of keys) {
    if (key in managed || !(key in result)) continue;
    if (previous.values && !deepEqual(result[key], previous.values[key])) continue;
    delete result[key];
  }
  return result;
}
