// Builds the PowerShell script for a Windows toast. Kept pure so tests don't need a desktop.
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

// Windows PowerShell's own AppUserModelID: lets a toast show without registering an app.
const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

// Control characters other than tab and newlines are invalid in XML 1.0 and would make LoadXml throw.
export function xmlEscape(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function toastTitle(cwd) {
  // <repo>/.claude/worktrees/<name>/... is a worktree of <repo> (claude --worktree).
  const worktree = cwd ? /([^\\/]+)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/.exec(cwd) : null;
  if (worktree) return `Claude Code · ${worktree[1]} (${worktree[2]})`;
  // Split on both separators: a hook on macOS can still see a Windows path, and path.basename there
  // only knows "/".
  const name = cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? "") : "";
  return name ? `Claude Code · ${name}` : "Claude Code";
}

export function buildToastScript(title, message) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text></binding></visual></toast>`;
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('${xml}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
  ].join("\n");
}

export function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// macOS: title and message travel as arguments of a run handler, never as script text. A leading
// dash would read as an osascript option, so it gets a space in front.
export function macNotificationArgs(title, message) {
  const safe = (text) => (String(text).startsWith("-") ? ` ${text}` : String(text));
  return ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", safe(title), safe(message)];
}

export function notificationCommand(title, message, platform = process.platform) {
  if (platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodePowerShell(buildToastScript(title, message))],
    };
  }
  if (platform === "darwin") return { file: "osascript", args: macNotificationArgs(title, message) };
  // Linux desktops: "--" keeps a title or message that starts with a dash from reading as an option.
  // Without notify-send the spawn fails and showNotification returns quietly.
  if (platform === "linux") return { file: "notify-send", args: ["--", String(title), String(message)] };
  return null;
}

// Shows the notification and waits for the tool to finish. Never detached: a detached PowerShell
// has no console and exits 0 without showing anything. Waiting also keeps the hook runner from
// ending it early; the deadline stays below the hook's 15 s timeout.
export function showNotification(title, message, { platform = process.platform, spawn = nodeSpawn, timeoutMs = 10000 } = {}) {
  const command = notificationCommand(title, message, platform);
  if (!command) return Promise.resolve();
  return new Promise((resolve) => {
    const child = spawn(command.file, command.args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on("exit", finish);
    child.on("error", finish);
  });
}
