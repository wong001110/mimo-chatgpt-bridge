import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CompletionActions } from "../src/actions/completion-actions.js";
import { createBridgeHttpServer } from "../src/http/server.js";
import { CompletionStore } from "../src/store/completion-store.js";

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

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-review-console-"));
  const store = new CompletionStore(path.join(directory, "bridge.sqlite"));
  const completion = store.insertCompletion({
    eventKey: "session:message",
    sessionId: "session",
    assistantMessageId: "message",
    projectDir: directory,
    worktree: directory,
    assistantText: "Implemented the task.",
    completedAt: new Date().toISOString(),
    tests: [{ command: "npm test", exitCode: 0, output: "passed" }],
    git: { isGitRepository: true, branch: "main", diff: "+change" },
    maxIterations: 3,
  }).completion;
  const sent = [];
  const actions = new CompletionActions({
    store,
    mimoClient: {
      async sendInstruction(sessionId, instruction) {
        sent.push({ sessionId, instruction });
      },
    },
    logger: { info() {} },
  });
  const config = {
    reviewMode: "desktop",
    desktopEnabled: true,
    webhookPath: "/hooks/mimo-completed",
    mcpPath: "/mcp/token",
    mcpAllowedHosts: ["127.0.0.1", "localhost"],
    mcpAuthToken: "",
    bridgeToken: "bridge-secret",
    maxWebhookBytes: 1_048_576,
    maxAssistantTextBytes: 100_000,
    maxDiffBytes: 100_000,
    allowedRoots: [],
    maxAutoIterations: 3,
  };
  const server = createBridgeHttpServer({
    config,
    store,
    actions,
    orchestrator: { handleNewCompletion: async () => {} },
    mcpHandler: { handle: async () => {} },
    logger: { error() {} },
  });
  return { store, completion, actions, sent, server };
}

test("localhost review page exposes evidence without leaking the capability token", async () => {
  const { store, completion, server } = fixture();
  try {
    const address = await listen(server);
    const response = await fetch(
      `http://127.0.0.1:${address.port}/review/${completion.reviewToken}`,
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /MiMoCode completion review/);
    assert.match(html, /Implemented the task/);
    assert.match(html, /\+change/);
    assert.doesNotMatch(html, /reviewToken/);
    assert.match(response.headers.get("content-security-policy"), /form-action 'self'/);
  } finally {
    await close(server);
    store.close();
  }
});

test("review page can approve exactly once", async () => {
  const { store, completion, server } = fixture();
  try {
    const address = await listen(server);
    const actionUrl = `http://127.0.0.1:${address.port}/review/${completion.reviewToken}/action`;
    const response = await fetch(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "approve", summary: "Tests and diff verified." }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Completion approved/);
    const updated = store.get(completion.id);
    assert.equal(updated.status, "reviewed");
    assert.equal(updated.review.source, "chatgpt_desktop_review_page");

    const duplicate = await fetch(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "instruction", instruction: "Change it again." }),
    });
    assert.equal(duplicate.status, 409);
  } finally {
    await close(server);
    store.close();
  }
});

test("review page sends one instruction back to the bound MiMoCode session", async () => {
  const { store, completion, sent, server } = fixture();
  try {
    const address = await listen(server);
    const response = await fetch(
      `http://127.0.0.1:${address.port}/review/${completion.reviewToken}/action`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          action: "instruction",
          instruction: "Add a regression test for the failing path.",
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(sent, [
      { sessionId: "session", instruction: "Add a regression test for the failing path." },
    ]);
    assert.equal(store.get(completion.id).status, "instruction_sent");
  } finally {
    await close(server);
    store.close();
  }
});
