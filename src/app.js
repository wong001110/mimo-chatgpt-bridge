import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { CompletionStore } from "./store/completion-store.js";
import { MimoClient } from "./mimo/client.js";
import { DesktopDriver } from "./desktop/driver.js";
import { OpenAIReviewer } from "./review/openai-reviewer.js";
import { ReviewOrchestrator } from "./review/orchestrator.js";
import { CompletionActions } from "./actions/completion-actions.js";
import { McpHttpHandler } from "./mcp/http-handler.js";
import { createBridgeHttpServer } from "./http/server.js";

export function createBridgeApp({ config: suppliedConfig, overrides = {} } = {}) {
  const config = suppliedConfig || loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const logger = overrides.logger || createLogger({ level: config.logLevel });
  const store = overrides.store || new CompletionStore(config.databasePath);
  const mimoClient = overrides.mimoClient || new MimoClient({
    baseUrl: config.mimoServerUrl,
    logger,
  });
  const desktop = overrides.desktop || new DesktopDriver({ config, logger });
  const reviewer = overrides.reviewer ||
    (["api", "hybrid"].includes(config.reviewMode)
      ? new OpenAIReviewer({
          apiKey: config.openaiApiKey,
          model: config.openaiModel,
          logger,
        })
      : null);
  const actions = overrides.actions || new CompletionActions({ store, mimoClient, logger });
  const orchestrator = overrides.orchestrator || new ReviewOrchestrator({
    store,
    reviewer,
    mimoClient,
    desktop,
    config,
    logger,
  });
  const mcpHandler = overrides.mcpHandler || new McpHttpHandler({
    store,
    actions,
    config,
  });
  const server = createBridgeHttpServer({
    config,
    store,
    actions,
    orchestrator,
    mcpHandler,
    logger,
  });

  return {
    config,
    logger,
    store,
    mimoClient,
    desktop,
    reviewer,
    actions,
    orchestrator,
    mcpHandler,
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      logger.info("MiMo ChatGPT Bridge started", {
        address,
        reviewMode: config.reviewMode,
        mcpPath: "/mcp/<redacted>",
      });
      setImmediate(() => {
        void orchestrator.recoverPending().catch((error) => {
          logger.error("Pending completion recovery failed", { error: error.message });
        });
      });
      return address;
    },
    async close() {
      await mcpHandler.close();
      await new Promise((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
