// Decides whether a shell command publishes somewhere protected and needs the user's confirmation:
// pushes to the default branch, tags, force pushes, auto-merges, and merges or releases through gh or glab.
import os from "node:os";

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const RISKY_PUSH_FLAGS = new Set([
  "--tags", "--follow-tags", "--mirror", "--all", "--delete", "-d", "--prune",
  "--force", "-f", "--force-with-lease", "--force-if-includes",
]);
const PUSH_OPTIONS_WITH_VALUE = new Set(["--repo", "--receive-pack", "--exec"]);
// GitLab push options that merge the merge request as soon as its pipeline passes.
const AUTO_MERGE_OPTION = /^merge_request\.(merge_when_pipeline_succeeds|auto_merge)(=|$)/;
const GIT_OPTIONS_WITH_VALUE = new Set(["-c", "--git-dir", "--work-tree", "--namespace"]);
const FORGE_RISKS = {
  gh: {
    pr: { merge: "gh pr merge merges into the base branch, which may deploy" },
    release: {
      create: "gh release create publishes a release",
      edit: "gh release edit changes a published release",
      delete: "gh release delete removes a release",
    },
    repo: {
      edit: "gh repo edit changes repository settings",
      rename: "gh repo rename renames a repository",
      archive: "gh repo archive archives a repository",
      delete: "gh repo delete deletes a repository",
    },
    workflow: { run: "gh workflow run starts a workflow, which may deploy" },
  },
  glab: {
    mr: {
      merge: "glab mr merge merges into the target branch, which may deploy",
      accept: "glab mr accept merges into the target branch, which may deploy",
    },
    release: {
      create: "glab release create publishes a release",
      update: "glab release update changes a published release",
      upload: "glab release upload changes a published release",
      delete: "glab release delete removes a release",
    },
    repo: {
      update: "glab repo update changes repository settings",
      transfer: "glab repo transfer moves a repository to another namespace",
      delete: "glab repo delete deletes a repository",
    },
    ci: {
      trigger: "glab ci trigger starts a manual job, which may deploy",
      run: "glab ci run starts a pipeline, which may deploy",
      "run-trig": "glab ci run-trig starts a pipeline, which may deploy",
    },
  },
};
// REST endpoints that merge or publish, per CLI.
const API_RISKY_ENDPOINT = {
  gh: /(^|\/)(pulls\/\d+\/merge|merges|releases(\/.*)?)$/,
  glab: /(^|\/)(merge_requests\/\d+\/merge|releases(\/.*)?|repository\/tags(\/.*)?|jobs\/\d+\/play)$/,
};
const API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input", "--form"]);
// glab's own aliases: pipeline and pipe for ci, project for repo, ci create for ci run, mr new for mr create.
const GLAB_GROUP_ALIASES = { pipeline: "ci", pipe: "ci", project: "repo" };
const GLAB_ACTION_ALIASES = { ci: { create: "run" }, mr: { new: "create" } };

// A directory the guard cannot follow: `cd -`, `popd` past the start, a Linux path inside wsl.
const UNKNOWN_DIR = Symbol("unknown directory");
const UNKNOWN_BRANCH = "git push from a branch that could not be determined";
// Wrappers nest (bash -c "wsl -- bash -c ..."); deeper than this is not assessed.
const MAX_DEPTH = 4;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ABSOLUTE_DIR = /^([\\/~]|[A-Za-z]:)/;
const DRIVE_DIR = /^[A-Za-z]:/;
// Shell grammar and the PowerShell call operator in front of the real command.
const LEAD_WORDS = new Set(["&", "!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);
// Programs that run their remaining arguments as a command, with their options that take a value.
const PREFIX_COMMANDS = new Map([
  ["env", new Set(["-u", "--unset", "-C", "--chdir"])],
  ["command", new Set()],
  ["exec", new Set(["-a"])],
  ["nohup", new Set()],
  ["time", new Set(["-f", "--format", "-o", "--output"])],
  ["sudo", new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"])],
  ["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
]);
const DIR_COMMANDS = new Set(["cd", "chdir", "sl", "set-location", "pushd", "push-location", "popd", "pop-location"]);
const WSL_OPTIONS_WITH_VALUE = new Set(["-d", "--distribution", "-u", "--user", "--shell-type", "--distribution-id"]);
const POWERSHELL_OPTIONS_WITH_VALUE = [
  "executionpolicy", "workingdirectory", "windowstyle", "version", "outputformat", "inputformat",
  "configurationname", "settingsfile", "psconsolefile", "custompipename",
];

// Splits a command line into simple commands, blind to quotes: a separator inside quotes can only
// cause an extra question, never a missed one. Parentheses come back as their own items.
function blindSegments(command) {
  // A lone & (background job, cmd's separator) splits too; &&, 2>&1 and &> do not.
  return command.split(/\s*(?:&&|\|\||;|\||\{|\}|\r?\n|(?<![>&])&(?![&>]))\s*|\s*([()])\s*/).filter(Boolean);
}

export function splitCommands(command) {
  return blindSegments(command).filter((segment) => segment !== "(" && segment !== ")");
}

// Splits like a shell: separators inside quotes stay, so `bash -c 'cd x && git push'` keeps its
// command string whole. Parentheses come back as their own items.
function shellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  const flush = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[++i];
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      flush();
      i++;
    } else if (ch === "&" && command[i - 1] !== ">" && command[i + 1] !== ">") {
      flush();
    } else if (";|\r\n".includes(ch)) {
      flush();
    } else if (ch === "(" || ch === ")") {
      flush();
      segments.push(ch);
    } else {
      current += ch;
    }
  }
  flush();
  return segments;
}

// Shell-word tokenizer: a word may join quoted and unquoted parts (NAME="a b"); quotes are dropped,
// and a quote without its partner (left over from splitting) is ignored.
export function tokenize(text) {
  const words = [];
  for (const [word] of text.matchAll(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])+/g)) {
    const unquoted = word.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_, double, single) => double ?? single);
    if (unquoted) words.push(unquoted);
  }
  return words;
}

// `C:\Program Files\Git\cmd\git.exe`, `/usr/bin/git`, `GIT.EXE` and `&git` are all `git`.
function programName(word) {
  return word.replace(/^&/, "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
}

// Turns a directory taken from a command into one Node can resolve on this platform: `~` is the
// home directory; on Windows `/c/x` is `C:/x` and other POSIX paths go through cygpath.
// Returns null when the directory cannot be mapped.
export function nativeDir(dir, { platform = process.platform, home = os.homedir(), cygpath = () => null } = {}) {
  if (/^~(?=$|[\\/])/.test(dir)) return home + dir.slice(1);
  if (platform !== "win32" || !/^\/(?![\\/])/.test(dir)) return dir;
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(dir);
  if (drive) return `${drive[1].toUpperCase()}:${drive[2] ?? "/"}`;
  return cygpath(dir) ?? null;
}

// `cd b` after `cd a` is `a/b`; an absolute target replaces. Inside wsl only /mnt/<drive> paths map
// back to Windows; any other absolute Linux path is a directory the guard cannot follow.
function composeDir(base, target, linux) {
  if (linux) {
    const mount = /^\/mnt\/([A-Za-z])(\/.*)?$/.exec(target);
    if (mount) return `${mount[1].toUpperCase()}:${mount[2] ?? "/"}`;
    if (ABSOLUTE_DIR.test(target)) return UNKNOWN_DIR;
  }
  if (ABSOLUTE_DIR.test(target)) return target;
  if (base === null || base === UNKNOWN_DIR) return base === null ? target : UNKNOWN_DIR;
  return `${base.replace(/[\\/]+$/, "")}/${target}`;
}

function dirArgument(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^-(path|literalpath|lp|pspath)$/i.test(arg)) return args[i + 1] ?? null;
    if (/^-stackname$/i.test(arg)) {
      i++;
      continue;
    }
    if (arg === "-") return null; // back to a directory the guard never saw
    if (arg.startsWith("-")) continue; // -P, -L, --, -PassThru
    return arg;
  }
  return null;
}

function changeDir(program, args, state, ctx) {
  if (program === "popd" || program === "pop-location") {
    state.dir = state.stack.length > 0 ? state.stack.pop() : UNKNOWN_DIR;
    return;
  }
  if (program === "pushd" || program === "push-location") state.stack.push(state.dir);
  const target = dirArgument(args);
  state.dir = target === null ? UNKNOWN_DIR : composeDir(state.dir, target, ctx.linux);
}

function refspecRisk(spec, currentBranch, isProtected) {
  if (spec.startsWith("+")) return `git push ${spec} force-updates the remote ref`;
  if (spec.startsWith(":")) return `git push ${spec} deletes a remote ref`;
  const destination = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
  if (destination.startsWith("refs/tags/") || /^v\d/.test(destination)) return `git push publishes tag ${destination}`;
  if (destination === "HEAD" || destination === "@") {
    const branch = currentBranch();
    if (branch == null) return UNKNOWN_BRANCH;
    return isProtected(branch) ? `git push targets ${branch}` : null;
  }
  const target = destination.replace(/^refs\/heads\//, "");
  return isProtected(target) ? `git push targets ${target}` : null;
}

// --push-option <v>, --push-option=<v> and the abbreviations git accepts (--push-o=<v>).
function longPushOption(arg, next) {
  const [name, ...value] = arg.split("=");
  if (name.length < 4 || !"--push-option".startsWith(name)) return null;
  return value.length > 0 ? { value: value.join("="), consumesNext: false } : { value: next ?? "", consumesNext: true };
}

// git accepts any unambiguous prefix of a long option; a prefix of a risky option counts as it.
function riskyLongFlag(name) {
  if (name.length < 3) return null;
  return [...RISKY_PUSH_FLAGS].find((flag) => flag.startsWith("--") && flag.startsWith(name)) ?? null;
}

// git bundles short options (-uf, -uo <v>); -o takes the rest of the cluster or the next word.
function shortCluster(arg, next) {
  const flags = [];
  for (let k = 1; k < arg.length; k++) {
    if (arg[k] === "o") {
      const rest = arg.slice(k + 1);
      return { flags, option: rest ? { value: rest, consumesNext: false } : { value: next ?? "", consumesNext: true } };
    }
    flags.push(`-${arg[k]}`);
  }
  return { flags, option: null };
}

function isRedirection(token) {
  // Matches tokens that are shell redirections: >, >>, <, 2>, &>, 2>&1, >&2, etc.
  return /^[0-9&<>]*[&<>]/.test(token);
}

function needsFilenameToken(token) {
  // Operators that consume the next token as filename: >, >>, <, <<, &>, &>>, and digit followed by >, >>, <
  // Examples: >, >>, <, <<, &>, &>>, 2>, 2>>, 0<
  // Self-contained redirections like 2>&1, 1>&2, >&2, >file, 2>/dev/null don't consume the next token.
  return /^(>|>>|<|<<|&>|&>>|[0-9]+(>|>>|<))$/.test(token);
}

function assessGitPush(args, dir, ctx) {
  let i = 0;
  let gitDir = dir;
  let autoMerge = null;
  while (i < args.length && args[i].startsWith("-")) {
    const arg = args[i];
    if (arg === "-C") {
      if (args[i + 1] !== undefined) gitDir = composeDir(gitDir, args[i + 1], ctx.linux);
      i += 2;
      continue;
    }
    // git -c push.pushOption=<v> push sends <v> like -o <v>.
    const setting = arg === "-c" ? /^push\.pushoption=(.*)$/i.exec(args[i + 1] ?? "") : null;
    if (setting && AUTO_MERGE_OPTION.test(setting[1])) autoMerge = setting[1];
    // Another repository or work tree: the directory's branch no longer tells what is pushed.
    if (/^--(git-dir|work-tree)(=|$)/.test(arg)) gitDir = UNKNOWN_DIR;
    i += GIT_OPTIONS_WITH_VALUE.has(arg) ? 2 : 1;
  }
  if (args[i] !== "push") return null;

  const flags = [];
  const positionals = [];
  const pushArgs = args.slice(i + 1);
  let j = 0;
  const takeOption = (option) => {
    if (!option) return;
    if (option.consumesNext) j++;
    if (AUTO_MERGE_OPTION.test(option.value)) autoMerge = option.value;
  };
  for (; j < pushArgs.length; j++) {
    const arg = pushArgs[j];
    if (PUSH_OPTIONS_WITH_VALUE.has(arg)) { j++; continue; }
    if (arg.startsWith("--")) {
      const option = longPushOption(arg, pushArgs[j + 1]);
      if (option) takeOption(option);
      else flags.push(riskyLongFlag(arg.split("=")[0]) ?? arg);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const cluster = shortCluster(arg, pushArgs[j + 1]);
      flags.push(...cluster.flags);
      takeOption(cluster.option);
      continue;
    }
    // Filter out shell redirections (>, >>, <, 2>, &>, 2>&1, >&2, >file, &>file, etc.)
    if (isRedirection(arg)) {
      if (needsFilenameToken(arg)) j++; // Skip filename token after operators like >, >>, <, 2>, 2>>, &>, &>>
      continue;
    }
    positionals.push(arg);
  }

  const risky = flags.find((flag) => RISKY_PUSH_FLAGS.has(flag));
  if (risky) return `git push ${risky} rewrites, deletes or publishes more than one feature branch`;
  if (autoMerge) return `git push -o ${autoMerge} merges automatically once the pipeline passes, which may deploy`;

  // "" is a detached HEAD (nothing to push by default); null means the branch could not be read.
  const currentBranch = () => (gitDir === UNKNOWN_DIR ? null : ctx.lookup(gitDir));
  // main, master and the default branch the pushed remote advertises; a URL counts as origin.
  const remote = positionals[0] && /^[\w.-]+$/.test(positionals[0]) ? positionals[0] : "origin";
  let protectedBranches = null;
  const isProtected = (branch) => {
    if (!protectedBranches) {
      const extra = gitDir === UNKNOWN_DIR ? null : ctx.lookupDefault(gitDir, remote);
      protectedBranches = extra ? new Set([...PROTECTED_BRANCHES, extra]) : PROTECTED_BRANCHES;
    }
    return protectedBranches.has(branch);
  };
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    const branch = currentBranch();
    if (branch == null) return UNKNOWN_BRANCH;
    return isProtected(branch) ? `git push from ${branch} publishes directly to ${branch}` : null;
  }
  for (const spec of refspecs) {
    const reason = refspecRisk(spec, currentBranch, isProtected);
    if (reason) return reason;
  }
  return null;
}

// gh api and glab api send GET unless -X/--method says otherwise or fields are given (then POST).
// Every other word may be the endpoint: an option whose value is the next word must not hide it.
function assessApi(cli, args) {
  let method = null;
  let hasFields = false;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const inline = /^(?:-X|--method=?)(.+)$/.exec(arg);
    if (inline) method = inline[1];
    else if (arg === "-X" || arg === "--method") method = args[++i];
    else if (API_FIELD_FLAGS.has(arg)) { hasFields = true; i++; }
    else if (/^(-f|-F|--field|--raw-field|--input|--form)=/.test(arg)) hasFields = true;
    else if (!arg.startsWith("-")) words.push(arg);
  }
  const verb = (method ?? (hasFields ? "POST" : "GET")).toUpperCase();
  const endpoint = words.find((word) => API_RISKY_ENDPOINT[cli].test(word.split("?")[0]));
  if (verb === "GET" || !endpoint) return null;
  return `${cli} api ${verb} ${endpoint} merges or publishes, which may deploy`;
}

const unalias = (table, key) => (Object.hasOwn(table, key) ? table[key] : key);

function assessForgeCli(cli, args) {
  let [group, action] = args;
  if (group === "api") return assessApi(cli, args.slice(1));
  if (cli === "glab") {
    group = unalias(GLAB_GROUP_ALIASES, group);
    if (Object.hasOwn(GLAB_ACTION_ALIASES, group)) action = unalias(GLAB_ACTION_ALIASES[group], action);
    if (group === "mr" && args.some((arg) => /^--auto-merge(=(?!false$).*)?$/.test(arg))) {
      return `glab mr ${action} --auto-merge merges automatically once the pipeline passes, which may deploy`;
    }
  }
  const risks = Object.hasOwn(FORGE_RISKS[cli], group) ? FORGE_RISKS[cli][group] : null;
  return risks && Object.hasOwn(risks, action) ? risks[action] : null;
}

// Drops assignments (GIT_TRACE=1), shell keywords and wrappers such as env, sudo or timeout 60.
function skipPrefixes(words) {
  let i = 0;
  while (i < words.length) {
    if (LEAD_WORDS.has(words[i]) || ASSIGNMENT.test(words[i])) {
      i++;
      continue;
    }
    const name = programName(words[i]);
    const options = PREFIX_COMMANDS.get(name);
    if (!options) break;
    i++;
    while (i < words.length && (words[i].startsWith("-") || (name === "env" && ASSIGNMENT.test(words[i])))) {
      i += options.has(words[i]) ? 2 : 1;
    }
    if (name === "timeout") i++; // the duration
  }
  return words.slice(i);
}

// One argument is the command string itself; several are joined back the way the shell got them.
const joinCommand = (args) => (args.length === 1 ? args[0] : args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "));

// bash|sh|zsh [options] -c|-lc <string>
function shellCommandString(args) {
  let command = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^[-+][oO]$/.test(arg)) {
      i++;
      continue;
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
      command = true;
      continue;
    }
    if (arg.startsWith("-") || arg.startsWith("+")) continue;
    return command ? arg : null;
  }
  return null;
}

// pwsh|powershell [options] -Command <string...>; like PowerShell, a first plain argument starts the command.
function powershellCommandString(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!/^[-/]/.test(arg)) return joinCommand(args.slice(i));
    const name = arg.slice(1).toLowerCase();
    if (/^c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(name)) return joinCommand(args.slice(i + 1));
    if (/^e(c|n|nc|ncodedcommand)?$/.test(name)) {
      return args[i + 1] === undefined ? null : Buffer.from(args[i + 1], "base64").toString("utf16le");
    }
    if (/^f(i(l(e)?)?)?$/.test(name)) return null;
    if (name === "ep" || name === "wd" || POWERSHELL_OPTIONS_WITH_VALUE.some((option) => option.startsWith(name))) i++;
  }
  return null;
}

// cmd [/d /s] /c|/k <string...>
function cmdCommandString(args) {
  const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
  return at === -1 ? null : joinCommand(args.slice(at + 1));
}

// wsl [options] [--|-e] <command...>: runs in Linux, starting in the current directory.
function assessWsl(args, state, ctx) {
  let dir = state.dir;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--" || arg === "-e" || arg === "--exec") {
      i++;
      break;
    }
    if (arg === "--cd") {
      const target = args[++i] ?? "";
      dir = DRIVE_DIR.test(target) ? target : composeDir(dir, target, true);
      continue;
    }
    if (WSL_OPTIONS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) break;
  }
  const inner = { ...ctx, linux: true, subshells: true, depth: ctx.depth + 1 };
  return inner.depth > MAX_DEPTH ? null : assessWords(args.slice(i), { dir, stack: [] }, inner);
}

function assessWords(allWords, state, ctx) {
  const words = skipPrefixes(allWords);
  if (words.length === 0) return null;
  const program = programName(words[0]);
  const args = words.slice(1);
  if (DIR_COMMANDS.has(program)) {
    changeDir(program, args, state, ctx);
    return null;
  }
  const nested = (command, subshells) =>
    command === null ? null : assessText(command, { ...ctx, dir: state.dir, subshells, depth: ctx.depth + 1 });
  // GIT_DIR=... or GIT_WORK_TREE=... in front of git points it at another repository.
  const otherRepo = allWords.slice(0, allWords.length - words.length).some((word) => /^GIT_(DIR|WORK_TREE)=/.test(word));
  switch (program) {
    case "git": return assessGitPush(args, otherRepo ? UNKNOWN_DIR : state.dir, ctx);
    case "gh": case "glab": return assessForgeCli(program, args);
    case "bash": case "sh": case "zsh": case "dash": return nested(shellCommandString(args), true);
    case "pwsh": case "powershell": return nested(powershellCommandString(args), false);
    case "cmd": return nested(cmdCommandString(args), false);
    case "wsl": return assessWsl(args, state, ctx);
    default: return null;
  }
}

function assessSegments(segments, ctx) {
  const state = { dir: ctx.dir, stack: [] };
  const scopes = [];
  for (const segment of segments) {
    if (segment === "(") {
      scopes.push({ dir: state.dir, stack: [...state.stack] });
    } else if (segment === ")") {
      // A bash subshell keeps its cd to itself; PowerShell parentheses do not.
      const scope = scopes.pop();
      if (scope && ctx.subshells) Object.assign(state, scope);
    } else {
      const reason = assessWords(tokenize(segment), state, ctx);
      if (reason) return reason;
    }
  }
  return null;
}

// Assesses both splits: the quote-blind one cannot be fooled by quoting it misreads, the
// shell-like one sees the whole command string of a wrapper such as bash -c.
function assessText(command, ctx) {
  if (ctx.depth > MAX_DEPTH) return null;
  for (const segments of [blindSegments(command), shellSegments(command)]) {
    const reason = assessSegments(segments, ctx);
    if (reason) return reason;
  }
  return null;
}

// branchOf(dir) answers the current branch of dir (null = the hook's cwd): a name, "" for a
// detached HEAD, or null when it cannot be determined. defaultBranchOf(dir, remote) answers the
// remote's default branch as the repository in dir knows it, or null. shell is "bash" or "powershell".
export function assessCommand(command, { branchOf = () => null, defaultBranchOf = () => null, shell = "bash" } = {}) {
  const cache = new Map();
  const cached = (key, answer) => {
    if (!cache.has(key)) cache.set(key, answer());
    return cache.get(key);
  };
  const lookup = (dir) => cached(`branch\0${dir ?? ""}`, () => branchOf(dir));
  const lookupDefault = (dir, remote) => cached(`default\0${dir ?? ""}\0${remote}`, () => defaultBranchOf(dir, remote));
  return assessText(command, { dir: null, linux: false, subshells: shell !== "powershell", depth: 0, lookup, lookupDefault });
}
