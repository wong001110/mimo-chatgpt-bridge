import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.cwd(), ".env");
const template = path.resolve(process.cwd(), ".env.example");
const force = process.argv.includes("--force");

if (!fs.existsSync(template)) {
  throw new Error(`Missing template: ${template}`);
}
if (fs.existsSync(target) && !force) {
  throw new Error(`${target} already exists. Re-run with --force only if replacing it is intentional.`);
}

const token = () => crypto.randomBytes(32).toString("base64url");
const bridgeToken = token();
const mcpPathToken = token();
const content = fs
  .readFileSync(template, "utf8")
  .replace("replace-with-a-long-random-token", bridgeToken)
  .replace("replace-with-a-second-long-random-token", mcpPathToken);

fs.writeFileSync(target, content, { mode: 0o600 });
console.log(`Created ${target}`);
console.log(`Local MCP path: http://127.0.0.1:8787/mcp/${mcpPathToken}`);
console.log("Keep .env private. It is excluded by .gitignore.");
