#!/usr/bin/env node
// Profile hook, run by the installer as `node setup.mjs <machine.json>` from this folder.
// Install tools your plugins need here (for example a language server). Delete it if you need none.
import fs from "node:fs";

const machine = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(`setup: nothing to do on ${machine.os}`);
