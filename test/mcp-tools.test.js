import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerBridgeTools } from "../src/mcp/create-server.js";
import { CompletionStore } from "../src/store/completion-store.js";
import { CompletionActions } from "../src/actions/completion-actions.js";

function chain() {
  const value = {};
  for (const name of ["optional", "int", "min", "max", "uuid"]) {
    value[name] = () => value;
  }
  return value;
}

const fakeZ = {
  enum: () => chain(),
  number: () => chain(),
  string: () => chain(),
  boolean: () => chain(),
};

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-mcp-tools-"));
  const store = new CompletionStore(path.join(directory, "bridge.sqlite"));
  const completion = store.insertCompletion({
    eventKey: "s:m",
    sessionId: "s",
    assistantMessageId: "m",
    projectDir: directory,
    worktree: directory,
    assistantText: "done",
    completedAt: new Date().toISOString(),
    tests: [],
    git: { isGitRepository: true, diff: "secret TOKEN=abcdefghijklmnop" },
    maxIterations: 3,
  }).completion;
  const tools = new Map();
  const server = {
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    },
  };
  const sent = [];
  const mimoClient = {
    async sendInstruction(sessionId, instruction) {
      sent.push({ sessionId, instruction });
    },
  };
  const actions = new CompletionActions({ store, mimoClient, logger: { info() {} } });
  registerBridgeTools(server, fakeZ, {
    store,
    actions,
    config: { reviewMode: "desktop", desktopEnabled: true, maxAutoIterations: 3 },
  });
  return { store, completion, tools, sent };
}

test("MCP tool registry exposes the intended bounded surface", () => {
  const { store, tools } = fixture();
  try {
    assert.deepEqual([...tools.keys()], [
      "bridge_status",
      "list_mimo_completions",
      "get_mimo_completion",
      "send_instruction_to_mimo",
      "mark_mimo_completion_reviewed",
      "stop_mimo_loop",
    ]);
    assert.equal(tools.get("bridge_status").config.annotations.readOnlyHint, true);
    assert.equal(tools.get("send_instruction_to_mimo").config.annotations.openWorldHint, false);
  } finally {
    store.close();
  }
});

test("MCP tools read evidence and send one instruction", async () => {
  const { store, completion, tools, sent } = fixture();
  try {
    const listed = parseResult(await tools.get("list_mimo_completions").handler({}));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].git.diff, undefined);

    const detail = parseResult(
      await tools.get("get_mimo_completion").handler({
        completionID: completion.id,
        includeDiff: true,
        includeAudit: true,
      }),
    );
    assert.match(detail.git.diff, /<redacted>/);
    assert.ok(detail.audit.length >= 1);

    const sentResult = parseResult(
      await tools.get("send_instruction_to_mimo").handler({
        completionID: completion.id,
        instruction: "Fix TOKEN=abcdefghijklmnop",
      }),
    );
    assert.equal(sentResult.accepted, true);
    assert.deepEqual(sent, [{ sessionId: "s", instruction: "Fix TOKEN=abcdefghijklmnop" }]);
    assert.equal(store.get(completion.id).status, "instruction_sent");
    assert.match(store.get(completion.id).lastInstruction, /<redacted>/);

    const duplicate = await tools.get("send_instruction_to_mimo").handler({
      completionID: completion.id,
      instruction: "Again",
    });
    assert.equal(duplicate.isError, true);
    assert.equal(sent.length, 1);
  } finally {
    store.close();
  }
});

test("MCP review and stop tools update persisted state", async () => {
  const { store, completion, tools } = fixture();
  try {
    const reviewed = parseResult(
      await tools.get("mark_mimo_completion_reviewed").handler({
        completionID: completion.id,
        verdict: "needs_user",
        summary: "Need TOKEN=abcdefghijklmnop",
      }),
    );
    assert.equal(reviewed.status, "waiting_user");
    assert.match(store.get(completion.id).review.summary, /<redacted>/);

    const stopped = parseResult(
      await tools.get("stop_mimo_loop").handler({
        completionID: completion.id,
        reason: "Blocked",
      }),
    );
    assert.equal(stopped.status, "stopped");
  } finally {
    store.close();
  }
});
