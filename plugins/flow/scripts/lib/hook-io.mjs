// Shared plumbing for the hook entry points: read the event from stdin and print decisions.

export async function readHookInput(stream = process.stdin) {
  let data = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) data += chunk;
  return data.trim() ? JSON.parse(data) : {};
}

export function preToolUseDecision(decision, reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

// Runs a hook body and prints what it returns. Any failure inside the hook lets the action
// proceed: a broken guard must never wedge a session. stderr on exit 0 only reaches the debug log.
export async function runHook(body) {
  try {
    const output = await body(await readHookInput());
    if (output) process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`flow hook error: ${error?.stack ?? error}\n`);
  }
  process.exitCode = 0;
}
