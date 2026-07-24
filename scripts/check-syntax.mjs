import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const roots = ["src", "test", "scripts"];
const files = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(full);
  }
}

for (const root of roots) walk(root);
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
console.log(`Syntax check passed for ${files.length} files.`);
