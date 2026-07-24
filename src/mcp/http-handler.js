import crypto from "node:crypto";
import { createMcpServer } from "./create-server.js";

function jsonRpcError(res, status, message) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export class McpHttpHandler {
  constructor(dependencies, { sdkLoader, serverFactory } = {}) {
    this.dependencies = dependencies;
    this.sessions = new Map();
    this.sdkPromise = null;
    this.sdkLoader =
      sdkLoader ||
      (() =>
        Promise.all([
          import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
          import("@modelcontextprotocol/sdk/types.js"),
        ]).then(([transportModule, typesModule]) => ({
          StreamableHTTPServerTransport: transportModule.StreamableHTTPServerTransport,
          isInitializeRequest: typesModule.isInitializeRequest,
        })));
    this.serverFactory = serverFactory || createMcpServer;
  }

  async #sdk() {
    if (!this.sdkPromise) this.sdkPromise = this.sdkLoader();
    return this.sdkPromise;
  }

  setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Authorization, Last-Event-ID",
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  }

  async handle(req, res, body) {
    this.setCors(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const { StreamableHTTPServerTransport, isInitializeRequest } = await this.#sdk();
    const sessionId = req.headers["mcp-session-id"];
    let entry = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;

    if (req.method === "POST") {
      if (!entry && !sessionId && isInitializeRequest(body)) {
        let transport;
        let server;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (newSessionId) => {
            this.sessions.set(newSessionId, { transport, server });
          },
        });
        server = await this.serverFactory(this.dependencies);
        entry = { transport, server };
        transport.onclose = () => {
          if (transport.sessionId) this.sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
      }

      if (!entry) {
        jsonRpcError(res, 400, "No valid MCP session ID provided.");
        return;
      }
      await entry.transport.handleRequest(req, res, body);
      return;
    }

    if (!["GET", "DELETE"].includes(req.method)) {
      jsonRpcError(res, 405, "Method not allowed.");
      return;
    }

    if (!entry) {
      jsonRpcError(res, 400, "Invalid or missing MCP session ID.");
      return;
    }
    await entry.transport.handleRequest(req, res);
  }

  async close() {
    await Promise.allSettled(
      [...this.sessions.values()].flatMap(({ transport, server }) => [
        transport.close(),
        server.close(),
      ]),
    );
    this.sessions.clear();
  }
}
