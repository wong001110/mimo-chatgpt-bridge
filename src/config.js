import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REVIEW_MODES = new Set(["desktop", "api", "hybrid", "none"]);
const DESKTOP_MODES = new Set(["companion", "active"]);

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

function parseList(value, delimiter = ",") {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseEnvText(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value.replace(/\\n/g, "\n");
  }
  return result;
}

export function loadEnvFile(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnvText(fs.readFileSync(filePath, "utf8"));
}

function requireSecret(name, value, strict) {
  if (!strict) return;
  if (!value || value.startsWith("replace-with-")) {
    throw new Error(`${name} must be set to a long random value.`);
  }
  if (value.length < 24) {
    throw new Error(`${name} must contain at least 24 characters.`);
  }
}

export function loadConfig({ cwd = process.cwd(), env = process.env, strict = true } = {}) {
  const fileEnv = loadEnvFile(path.resolve(cwd, ".env"));
  const merged = { ...fileEnv, ...env };

  const reviewMode = merged.REVIEW_MODE || "none";
  if (!REVIEW_MODES.has(reviewMode)) {
    throw new Error(`REVIEW_MODE must be one of: ${[...REVIEW_MODES].join(", ")}`);
  }

  const desktopMode = merged.CHATGPT_DESKTOP_MODE || "companion";
  if (!DESKTOP_MODES.has(desktopMode)) {
    throw new Error(`CHATGPT_DESKTOP_MODE must be one of: ${[...DESKTOP_MODES].join(", ")}`);
  }

  const bridgeToken = merged.MIMO_BRIDGE_TOKEN || "";
  const mcpPathToken = merged.MCP_PATH_TOKEN || "";
  requireSecret("MIMO_BRIDGE_TOKEN", bridgeToken, strict);
  requireSecret("MCP_PATH_TOKEN", mcpPathToken, strict);
  if (strict && !/^[A-Za-z0-9_-]+$/.test(mcpPathToken)) {
    throw new Error("MCP_PATH_TOKEN may contain only letters, numbers, underscore, and hyphen.");
  }

  if (strict && ["api", "hybrid"].includes(reviewMode) && !merged.OPENAI_API_KEY) {
    throw new Error(`OPENAI_API_KEY is required when REVIEW_MODE=${reviewMode}.`);
  }

  const dataDir = path.resolve(cwd, merged.BRIDGE_DATA_DIR || "./data");
  const port = parseInteger(merged.BRIDGE_PORT, 8787, { min: 1, max: 65535 });
  const allowedRoots = parseList(merged.MIMO_ALLOWED_ROOTS, path.delimiter).map((item) =>
    path.resolve(item),
  );

  return {
    cwd,
    host: merged.BRIDGE_HOST || "127.0.0.1",
    port,
    dataDir,
    databasePath: path.join(dataDir, "bridge.sqlite"),
    logLevel: merged.BRIDGE_LOG_LEVEL || "info",
    bridgeToken,
    webhookPath: "/hooks/mimo-completed",
    mimoServerUrl: merged.MIMO_SERVER_URL || "http://127.0.0.1:4096",
    allowedRoots,
    mcpPathToken,
    mcpPath: `/mcp/${mcpPathToken || "unset"}`,
    mcpAuthToken: merged.MCP_AUTH_TOKEN || "",
    mcpAllowedHosts: parseList(merged.MCP_ALLOWED_HOSTS || "127.0.0.1,localhost").map(
      (host) => host.toLowerCase(),
    ),
    reviewMode,
    reviewBaseUrl: (merged.BRIDGE_REVIEW_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, ""),
    maxAutoIterations: parseInteger(merged.MAX_AUTO_ITERATIONS, 3, { min: 0, max: 20 }),
    desktopEnabled: parseBoolean(merged.CHATGPT_DESKTOP_ENABLED, false),
    desktopMode,
    chatgptAppName: merged.CHATGPT_APP_NAME || "ChatGPT",
    chatgptAutoSubmit: parseBoolean(merged.CHATGPT_AUTO_SUBMIT, true),
    chatgptOpenDelayMs: parseInteger(merged.CHATGPT_OPEN_DELAY_MS, 900, {
      min: 0,
      max: 10000,
    }),
    chatgptPasteDelayMs: parseInteger(merged.CHATGPT_PASTE_DELAY_MS, 250, {
      min: 0,
      max: 10000,
    }),
    openaiApiKey: merged.OPENAI_API_KEY || "",
    openaiModel: merged.OPENAI_MODEL || "gpt-5",
    maxWebhookBytes: parseInteger(merged.MAX_WEBHOOK_BYTES, 1_048_576, {
      min: 1024,
      max: 20_000_000,
    }),
    maxDiffBytes: parseInteger(merged.MAX_DIFF_BYTES, 200_000, {
      min: 1000,
      max: 5_000_000,
    }),
    maxAssistantTextBytes: parseInteger(merged.MAX_ASSISTANT_TEXT_BYTES, 100_000, {
      min: 1000,
      max: 2_000_000,
    }),
    platform: os.platform(),
  };
}
