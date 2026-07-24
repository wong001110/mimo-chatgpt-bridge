import http from "node:http";
import { collectGitSnapshot } from "../git.js";
import { handleReviewConsole } from "./review-console.js";
import {
  isPathWithinRoots,
  limitUtf8,
  redactSecrets,
  redactValue,
  verifyBearer,
} from "../security.js";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`Payload exceeds ${maxBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function validateCompletionEvent(body) {
  const nonEmpty = ["eventID", "sessionID", "assistantMessageID", "directory"];
  for (const field of nonEmpty) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      const error = new Error(`${field} is required.`);
      error.statusCode = 400;
      throw error;
    }
  }
  if (typeof body.assistantText !== "string") {
    const error = new Error("assistantText must be a string.");
    error.statusCode = 400;
    throw error;
  }
  return body;
}

function hostWithoutPort(req) {
  const host = req.headers.host || "";
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0].toLowerCase();
}

export function createBridgeHttpServer({ config, store, actions, orchestrator, mcpHandler, logger }) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");

    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          healthy: store.health(),
          reviewMode: config.reviewMode,
          desktopEnabled: config.desktopEnabled,
          mcpEndpoint: "/mcp/<redacted>",
        });
        return;
      }

      if (url.pathname.startsWith("/review/")) {
        const handled = await handleReviewConsole(req, res, url, { store, actions });
        if (handled) return;
      }

      if (url.pathname === config.mcpPath) {
        const host = hostWithoutPort(req);
        if (config.mcpAllowedHosts.length && !config.mcpAllowedHosts.includes(host)) {
          sendJson(res, 403, { error: `Host ${host || "<missing>"} is not allowed.` });
          return;
        }
        if (config.mcpAuthToken && !verifyBearer(req.headers.authorization, config.mcpAuthToken)) {
          res.setHeader("www-authenticate", "Bearer");
          sendJson(res, 401, { error: "Unauthorized." });
          return;
        }
        const body = req.method === "POST" ? await readJson(req, config.maxWebhookBytes) : undefined;
        await mcpHandler.handle(req, res, body);
        return;
      }

      if (req.method === "POST" && url.pathname === config.webhookPath) {
        if (!verifyBearer(req.headers.authorization, config.bridgeToken)) {
          sendJson(res, 401, { error: "Unauthorized." });
          return;
        }
        const body = validateCompletionEvent(await readJson(req, config.maxWebhookBytes));
        const projectDir = body.worktree || body.directory;
        if (!isPathWithinRoots(projectDir, config.allowedRoots)) {
          sendJson(res, 403, { error: "Project directory is outside MIMO_ALLOWED_ROOTS." });
          return;
        }

        const git = await collectGitSnapshot(projectDir, { maxDiffBytes: config.maxDiffBytes });
        const result = store.insertCompletion({
          eventKey: body.eventID,
          sessionId: body.sessionID,
          assistantMessageId: body.assistantMessageID,
          projectDir: body.directory,
          worktree: body.worktree || body.directory,
          assistantText: limitUtf8(
            redactSecrets(body.assistantText),
            config.maxAssistantTextBytes,
          ),
          completedAt: body.completedAt || new Date().toISOString(),
          tests: Array.isArray(body.tests) ? redactValue(body.tests) : [],
          git,
          maxIterations: config.maxAutoIterations,
        });

        if (result.inserted) {
          setImmediate(() => {
            void orchestrator.handleNewCompletion(result.completion).catch((error) => {
              logger?.error("Completion orchestration failed", {
                completionId: result.completion.id,
                error: error.message,
              });
            });
          });
        }

        sendJson(res, result.inserted ? 202 : 200, {
          accepted: true,
          duplicate: !result.inserted,
          completionID: result.completion.id,
          status: store.get(result.completion.id).status,
        });
        return;
      }

      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      logger?.error("HTTP request failed", { error: error.message, method: req.method, url: req.url });
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: error.message });
      else res.end();
    }
  });

  return server;
}
