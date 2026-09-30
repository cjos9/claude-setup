# Security

## Reporting a vulnerability

Report vulnerabilities privately: on the repository's **Security** tab, choose **Report a vulnerability**. Do not open a public issue for them.

Only the latest commit on `main` is supported.

## Scope

In scope:

- The installer or a hook exposing secrets, or running code it should not.
- A guard that lets a plainly written command through that the README's [What the guards do](README.md#what-the-guards-do) table covers.
- A secret rule that does not hold for Claude's file tools or shell file commands.

Out of scope: pushes through shell expansion (`eval`, variables, `xargs`, piping into a shell), git aliases or scripts, and files that a script or program opens itself. The README names these limits and what enforces them instead (auto mode's classifier, branch protection on the forge, Claude Code's sandbox).
