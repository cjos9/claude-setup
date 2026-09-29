#!/usr/bin/env node
// Prints, as JSON, the forge of the repository around the current directory: remote, host, project,
// kind (github, gitlab, unknown), the signed-in CLI (gh, glab or null) and the default branch.
// Used by the ship and setup-project skills.
import { describeRepo } from "./lib/forge.mjs";

console.log(JSON.stringify(describeRepo(process.cwd()), null, 2));
