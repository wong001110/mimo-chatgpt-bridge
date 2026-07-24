#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createBridgeApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { CompletionStore } from "./store/completion-store.js";
import { MimoClient } from "./mimo/client.js";
import { DesktopDriver } from "./desktop/driver.js";

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");

function printHelp() {
  console.log(`mimo-chatgpt-bridge

Commands:
  start                         Start webhook and MCP server
  doctor                        Check local prerequisites and connectivity
  install-plugin [projectDir]   Install MiMoCode completion plugin
  trigger <completionID>        Trigger ChatGPT desktop for a stored completion
  review <completionID>         Run the configured OpenAI API reviewer
  help                          Show this help
`);
}

async function commandStart() {
  const app = createBridgeApp();
  await app.start();
  const shutdown = async (signal) => {
    app.logger.info("Shutting down", { signal });
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function checkCommand(command, args = ["--version"]) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000 });
    return { ok: true, detail: (stdout || stderr).trim().split("\n")[0] };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

async function commandDoctor() {
  let config;
  try {
    config = loadConfig({ strict: false });
  } catch (error) {
    console.error(`config: FAIL - ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const logger = createLogger({ level: "error" });
  const checks = [];
  checks.push({ name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version });
  checks.push({ name: "MIMO_BRIDGE_TOKEN", ok: config.bridgeToken.length >= 24, detail: config.bridgeToken ? "set" : "missing" });
  checks.push({ name: "MCP_PATH_TOKEN", ok: config.mcpPathToken.length >= 24, detail: config.mcpPathToken ? "set" : "missing" });

  const store = new CompletionStore(config.databasePath);
  checks.push({ name: "SQLite", ok: store.health(), detail: config.databasePath });
  store.close();

  const git = await checkCommand("git");
  checks.push({ name: "Git", ...git });
  const cloudflared = await checkCommand("cloudflared");
  checks.push({ name: "cloudflared", ...cloudflared });

  const desktop = new DesktopDriver({ config, logger });
  checks.push({
    name: "ChatGPT desktop platform",
    ok: !config.desktopEnabled || desktop.isSupported(),
    detail: config.desktopEnabled ? config.platform : "disabled",
  });

  try {
    const mimo = new MimoClient({ baseUrl: config.mimoServerUrl, logger });
    const health = await Promise.race([
      mimo.health(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    checks.push({ name: "MiMoCode server", ok: true, detail: JSON.stringify(health) });
  } catch (error) {
    checks.push({ name: "MiMoCode server", ok: false, detail: error.message });
  }

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  }
  if (checks.some((item) => !item.ok)) process.exitCode = 1;
}

function commandInstallPlugin(targetArg, force) {
  const targetRoot = path.resolve(targetArg || process.cwd());
  const source = path.join(projectRoot, "mimo-plugin", "chatgpt-bridge.ts");
  const destinationDir = path.join(targetRoot, ".opencode", "plugins");
  const destination = path.join(destinationDir, "chatgpt-bridge.ts");
  fs.mkdirSync(destinationDir, { recursive: true });
  if (fs.existsSync(destination) && !force) {
    throw new Error(`${destination} already exists. Pass --force to replace it.`);
  }
  fs.copyFileSync(source, destination);
  console.log(`Installed MiMoCode plugin: ${destination}`);
}

async function commandTrigger(completionID) {
  const config = loadConfig();
  const store = new CompletionStore(config.databasePath);
  try {
    const completion = store.get(completionID);
    if (!completion) throw new Error("Completion not found.");
    const desktop = new DesktopDriver({ config, logger: createLogger({ level: config.logLevel }) });
    await desktop.triggerReview(completion);
    store.markTriggered(completionID);
    console.log(`Triggered ChatGPT desktop for ${completionID}.`);
  } finally {
    store.close();
  }
}

async function commandReview(completionID) {
  const config = loadConfig();
  if (!["api", "hybrid"].includes(config.reviewMode)) {
    throw new Error("Set REVIEW_MODE=api or hybrid before using the review command.");
  }
  const app = createBridgeApp({ config });
  try {
    const result = await app.orchestrator.runApiReview(completionID);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    app.store.close();
  }
}

async function main() {
  const [command = "start", ...args] = process.argv.slice(2);
  try {
    if (command === "start") return commandStart();
    if (command === "doctor") return commandDoctor();
    if (command === "install-plugin") {
      return commandInstallPlugin(args.find((arg) => !arg.startsWith("--")), args.includes("--force"));
    }
    if (command === "trigger") return commandTrigger(args[0]);
    if (command === "review") return commandReview(args[0]);
    if (["help", "--help", "-h"].includes(command)) return printHelp();
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
