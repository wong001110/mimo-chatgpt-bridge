import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewOrchestrator } from "../src/review/orchestrator.js";
import { CompletionStore } from "../src/store/completion-store.js";

function fixture({ maxIterations = 3 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-orchestrator-"));
  const store = new CompletionStore(path.join(directory, "bridge.sqlite"));
  const completion = store.insertCompletion({
    eventKey: "s:m1",
    sessionId: "s",
    assistantMessageId: "m1",
    projectDir: directory,
    worktree: directory,
    assistantText: "done",
    completedAt: new Date().toISOString(),
    tests: [],
    git: null,
    maxIterations,
  }).completion;
  return { store, completion, directory };
}

function orchestrator({ store, decision, instruction = "Fix it", sent = [] }) {
  return new ReviewOrchestrator({
    store,
    reviewer: { review: async () => ({ decision, summary: "summary", instruction }) },
    mimoClient: {
      sendInstruction: async (sessionId, value) => {
        sent.push({ sessionId, value });
      },
    },
    desktop: { triggerReview: async () => ({ skipped: true }) },
    config: { reviewMode: "api", desktopEnabled: false },
    logger: { error() {} },
  });
}

test("API reviewer can approve a completion", async () => {
  const { store, completion } = fixture();
  try {
    const result = await orchestrator({ store, decision: "approve", instruction: "" }).runApiReview(
      completion.id,
    );
    assert.equal(result.status, "reviewed");
    assert.equal(result.review.decision, "approve");
  } finally {
    store.close();
  }
});

test("API reviewer sends one precise follow-up", async () => {
  const { store, completion } = fixture();
  const sent = [];
  try {
    const result = await orchestrator({ store, decision: "request_changes", sent }).runApiReview(
      completion.id,
    );
    assert.equal(result.status, "instruction_sent");
    assert.deepEqual(sent, [{ sessionId: "s", value: "Fix it" }]);
  } finally {
    store.close();
  }
});

test("API reviewer waits for user at iteration limit", async () => {
  const { store, completion } = fixture({ maxIterations: 1 });
  try {
    store.claimInstruction(completion.id, "first");
    store.completeInstruction(completion.id);
    const child = store.insertCompletion({
      eventKey: "s:m2",
      sessionId: "s",
      assistantMessageId: "m2",
      projectDir: completion.projectDir,
      worktree: completion.worktree,
      assistantText: "second",
      completedAt: new Date().toISOString(),
      tests: [],
      git: null,
      maxIterations: 1,
    }).completion;
    const sent = [];
    const result = await orchestrator({ store, decision: "request_changes", sent }).runApiReview(
      child.id,
    );
    assert.equal(result.status, "waiting_user");
    assert.equal(sent.length, 0);
  } finally {
    store.close();
  }
});


test("desktop recovery skips completions already triggered", async () => {
  const { store, completion } = fixture();
  const triggered = [];
  try {
    const instance = new ReviewOrchestrator({
      store,
      reviewer: null,
      mimoClient: null,
      desktop: {
        async triggerReview(item) {
          triggered.push(item.id);
        },
      },
      config: { reviewMode: "desktop", desktopEnabled: true },
      logger: { error() {} },
    });
    await instance.recoverPending();
    assert.deepEqual(triggered, [completion.id]);
    assert.ok(store.get(completion.id).triggeredAt);
    await instance.recoverPending();
    assert.deepEqual(triggered, [completion.id]);
  } finally {
    store.close();
  }
});
