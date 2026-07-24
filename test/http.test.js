import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBridgeHttpServer } from "../src/http/server.js";
import { CompletionStore } from "../src/store/completion-store.js";

function initializeRepository(cwd) {
  execFileSync("git", ["init", "-b", "main"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  fs.writeFileSync(path.join(cwd, "file.txt"), "initial\n");
  execFileSync("git", ["add", "file.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd });
  fs.writeFileSync(path.join(cwd, "file.txt"), "initial\nchanged\n");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("webhook authenticates, stores once, redacts, and orchestrates once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-http-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  initializeRepository(project);
  const store = new CompletionStore(path.join(root, "bridge.sqlite"));
  const calls = [];
  const config = {
    reviewMode: "none",
    desktopEnabled: false,
    webhookPath: "/hooks/mimo-completed",
    mcpPath: "/mcp/token",
    mcpAllowedHosts: ["127.0.0.1", "localhost"],
    mcpAuthToken: "",
    bridgeToken: "bridge-secret",
    maxWebhookBytes: 1_048_576,
    maxAssistantTextBytes: 100_000,
    maxDiffBytes: 100_000,
    allowedRoots: [root],
    maxAutoIterations: 3,
  };
  const server = createBridgeHttpServer({
    config,
    store,
    orchestrator: { handleNewCompletion: async (item) => calls.push(item.id) },
    mcpHandler: {
      handle: async (_req, res) => {
        res.statusCode = 200;
        res.end("mcp");
      },
    },
    logger: { error() {} },
  });

  try {
    const address = await listen(server);
    const base = `http://127.0.0.1:${address.port}`;
    const body = {
      eventID: "session:message",
      sessionID: "session",
      assistantMessageID: "message",
      directory: project,
      worktree: project,
      assistantText: "done OPENAI_API_KEY=sk-abcdefghijklmnop",
      tests: [{ command: "npm test", output: "TOKEN=abcdefghijklmnop" }],
      completedAt: "2026-07-25T00:00:00.000Z",
    };

    const unauthorized = await fetch(`${base}/hooks/mimo-completed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(unauthorized.status, 401);

    const send = () =>
      fetch(`${base}/hooks/mimo-completed`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer bridge-secret",
        },
        body: JSON.stringify(body),
      });
    const first = await send();
    const firstJson = await first.json();
    assert.equal(first.status, 202);
    assert.equal(firstJson.duplicate, false);

    const duplicate = await send();
    const duplicateJson = await duplicate.json();
    assert.equal(duplicate.status, 200);
    assert.equal(duplicateJson.duplicate, true);
    assert.equal(duplicateJson.completionID, firstJson.completionID);
    for (let attempt = 0; attempt < 20 && calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(calls.length, 1);

    const stored = store.get(firstJson.completionID);
    assert.equal(stored.assistantText.includes("sk-abcdefghijklmnop"), false);
    assert.match(stored.tests[0].output, /<redacted>/);
    assert.equal(stored.git.isGitRepository, true);
    assert.match(stored.git.diff, /\+changed/);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).healthy, true);
  } finally {
    await close(server);
    store.close();
  }
});

test("webhook rejects project paths outside the allowlist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-http-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-http-outside-"));
  const store = new CompletionStore(path.join(root, "bridge.sqlite"));
  const config = {
    reviewMode: "none",
    desktopEnabled: false,
    webhookPath: "/hooks/mimo-completed",
    mcpPath: "/mcp/token",
    mcpAllowedHosts: ["127.0.0.1"],
    mcpAuthToken: "",
    bridgeToken: "bridge-secret",
    maxWebhookBytes: 1_048_576,
    maxAssistantTextBytes: 100_000,
    maxDiffBytes: 100_000,
    allowedRoots: [root],
    maxAutoIterations: 3,
  };
  const server = createBridgeHttpServer({
    config,
    store,
    orchestrator: { handleNewCompletion: async () => {} },
    mcpHandler: { handle: async () => {} },
    logger: { error() {} },
  });
  try {
    const address = await listen(server);
    const response = await fetch(`http://127.0.0.1:${address.port}/hooks/mimo-completed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bridge-secret",
      },
      body: JSON.stringify({
        eventID: "e",
        sessionID: "s",
        assistantMessageID: "m",
        directory: outside,
        assistantText: "done",
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(store.list().length, 0);
  } finally {
    await close(server);
    store.close();
  }
});
