import assert from "node:assert/strict";
import test from "node:test";
import { McpHttpHandler } from "../src/mcp/http-handler.js";

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(value = "") {
      this.body += value;
      this.ended = true;
    },
  };
}

class FakeTransport {
  constructor(options) {
    this.options = options;
    this.requests = [];
    this.closed = false;
  }

  async handleRequest(req, res, body) {
    this.requests.push({ method: req.method, body });
    if (body?.method === "initialize" && !this.sessionId) {
      this.sessionId = "session-1";
      this.options.onsessioninitialized(this.sessionId);
      res.setHeader("Mcp-Session-Id", this.sessionId);
    }
    if (req.method === "DELETE") this.onclose?.();
    res.end("ok");
  }

  async close() {
    this.closed = true;
    this.onclose?.();
  }
}

test("MCP HTTP handler initializes, reuses, and closes stateful sessions", async () => {
  const servers = [];
  const handler = new McpHttpHandler(
    {},
    {
      sdkLoader: async () => ({
        StreamableHTTPServerTransport: FakeTransport,
        isInitializeRequest: (body) => body?.method === "initialize",
      }),
      serverFactory: async () => {
        const server = {
          connected: false,
          closed: false,
          async connect(transport) {
            this.connected = true;
            this.transport = transport;
          },
          async close() {
            this.closed = true;
          },
        };
        servers.push(server);
        return server;
      },
    },
  );

  const initRes = response();
  await handler.handle(
    { method: "POST", headers: {} },
    initRes,
    { jsonrpc: "2.0", id: 1, method: "initialize" },
  );
  assert.equal(initRes.statusCode, 200);
  assert.equal(initRes.headers["mcp-session-id"], "session-1");
  assert.equal(handler.sessions.size, 1);
  assert.equal(servers[0].connected, true);

  const postRes = response();
  await handler.handle(
    { method: "POST", headers: { "mcp-session-id": "session-1" } },
    postRes,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  );
  assert.equal(postRes.body, "ok");
  assert.equal(servers.length, 1);

  const getRes = response();
  await handler.handle(
    { method: "GET", headers: { "mcp-session-id": "session-1" } },
    getRes,
  );
  assert.equal(getRes.body, "ok");

  const deleteRes = response();
  await handler.handle(
    { method: "DELETE", headers: { "mcp-session-id": "session-1" } },
    deleteRes,
  );
  assert.equal(handler.sessions.size, 0);

  await handler.close();
});

test("MCP HTTP handler rejects invalid requests and handles CORS preflight", async () => {
  const handler = new McpHttpHandler(
    {},
    {
      sdkLoader: async () => ({
        StreamableHTTPServerTransport: FakeTransport,
        isInitializeRequest: () => false,
      }),
      serverFactory: async () => ({ connect: async () => {}, close: async () => {} }),
    },
  );

  const invalid = response();
  await handler.handle({ method: "POST", headers: {} }, invalid, { method: "tools/list" });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body, /No valid MCP session/);

  const preflight = response();
  await handler.handle({ method: "OPTIONS", headers: {} }, preflight);
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-expose-headers"], "Mcp-Session-Id");
});
