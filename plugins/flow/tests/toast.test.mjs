import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildToastScript, encodePowerShell, macNotificationArgs, notificationCommand, showNotification, toastTitle, xmlEscape } from "../scripts/lib/toast.mjs";

test("the title names the project folder", () => {
  assert.equal(toastTitle("C:\\Users\\me\\app"), "Claude Code · app");
  assert.equal(toastTitle("C:/Users/me/app/"), "Claude Code · app");
  assert.equal(toastTitle(undefined), "Claude Code");
});

test("a worktree title names the repository and the worktree", () => {
  assert.equal(toastTitle("C:\\Users\\me\\app\\.claude\\worktrees\\fix-login"), "Claude Code · app (fix-login)");
  assert.equal(toastTitle("C:/Users/me/app/.claude/worktrees/fix-login/src"), "Claude Code · app (fix-login)");
  assert.equal(toastTitle("/home/me/app/.claude/worktrees/fix-login/"), "Claude Code · app (fix-login)");
});

test("message text is XML-escaped and cannot break the PowerShell quoting", () => {
  const script = buildToastScript("T", `a < b & "c" 'd'`);
  assert.match(script, /a &lt; b &amp; &quot;c&quot; &apos;d&apos;/);
  const loadXml = script.split("\n").find((line) => line.startsWith("$xml.LoadXml("));
  assert.equal(loadXml.match(/'/g).length, 2);
});

test("encodePowerShell produces UTF-16LE base64", () => {
  assert.equal(Buffer.from(encodePowerShell("Ä · ok"), "base64").toString("utf16le"), "Ä · ok");
});

function fakeSpawn() {
  const calls = [];
  const child = new EventEmitter();
  child.kill = () => child.emit("exit", null);
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    return child;
  };
  return { spawn, calls, child };
}

test("showNotification starts PowerShell attached: a detached PowerShell exits 0 without showing the toast", async () => {
  const { spawn, calls, child } = fakeSpawn();
  const shown = showNotification("T", "M", { platform: "win32", spawn });
  child.emit("exit", 0);
  await shown;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.ok(calls[0].args.includes("-EncodedCommand"));
  assert.notEqual(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
});

test("showNotification waits for PowerShell, so the hook runner cannot end it early", async () => {
  const { spawn, child } = fakeSpawn();
  let done = false;
  const shown = showNotification("T", "M", { platform: "win32", spawn }).then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  child.emit("exit", 0);
  await shown;
  assert.equal(done, true);
});

test("showNotification gives up after its deadline and on spawn errors", async () => {
  const slow = fakeSpawn();
  await showNotification("T", "M", { platform: "win32", spawn: slow.spawn, timeoutMs: 10 });
  const broken = fakeSpawn();
  const shown = showNotification("T", "M", { platform: "win32", spawn: broken.spawn });
  broken.child.emit("error", new Error("ENOENT"));
  await shown;
});

test("PowerShell metacharacters in the message stay literal inside the single-quoted XML", () => {
  const message = "$(Remove-Item x) `n ; & | @{a=1} ${env:PATH}";
  const loadXml = buildToastScript("T", message).split("\n").find((line) => line.startsWith("$xml.LoadXml("));
  assert.equal(loadXml.match(/'/g).length, 2);
  assert.ok(loadXml.includes("$(Remove-Item x) `n ; &amp; | @{a=1} ${env:PATH}"));
});

test("XML-invalid control characters are dropped so LoadXml cannot fail", () => {
  assert.equal(xmlEscape("a\u0007b\u001bc\u0000d"), "abcd");
  assert.equal(xmlEscape("tab\tnew\nline"), "tab\tnew\nline");
});

test("macOS notifications pass title and message as arguments, never as script text", () => {
  const args = macNotificationArgs("Claude Code · app", `say "hi"' & do shell script "rm -rf ~"`);
  assert.deepEqual(args.slice(0, 6), ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run"]);
  assert.equal(args[7], `say "hi"' & do shell script "rm -rf ~"`);
});

test("a message that starts with a dash cannot become an osascript option", () => {
  assert.equal(macNotificationArgs("T", "-e boom")[7], " -e boom");
});

test("notificationCommand picks the platform's tool", () => {
  assert.equal(notificationCommand("T", "M", "darwin").file, "osascript");
  assert.equal(notificationCommand("T", "M", "win32").file, "powershell.exe");
  assert.deepEqual(notificationCommand("-T", "M", "linux"), { file: "notify-send", args: ["--", "-T", "M"] });
  assert.equal(notificationCommand("T", "M", "aix"), null);
});

test("showNotification starts the platform's tool and does nothing on other systems", async () => {
  const calls = [];
  const spawn = (file, args) => {
    calls.push(file);
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit("exit", 0));
    return child;
  };
  await showNotification("T", "M", { platform: "darwin", spawn });
  await showNotification("T", "M", { platform: "linux", spawn });
  await showNotification("T", "M", { platform: "aix", spawn });
  assert.deepEqual(calls, ["osascript", "notify-send"]);
});
