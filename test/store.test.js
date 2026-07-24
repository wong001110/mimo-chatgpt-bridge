import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CompletionStore } from "../src/store/completion-store.js";

function createStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-store-"));
  return new CompletionStore(path.join(directory, "bridge.sqlite"));
}

function input(overrides = {}) {
  return {
    eventKey: "session-1:message-1",
    sessionId: "session-1",
    assistantMessageId: "message-1",
    projectDir: "/tmp/project",
    worktree: "/tmp/project",
    assistantText: "done",
    completedAt: "2026-07-25T00:00:00.000Z",
    tests: [{ output: "TOKEN=abcdefghijklmnop" }],
    git: { isGitRepository: true, branch: "main", diff: "PASSWORD=abcdefghijklmnop" },
    maxIterations: 2,
    ...overrides,
  };
}

test("completion insertion is idempotent", () => {
  const store = createStore();
  try {
    const first = store.insertCompletion(input());
    const duplicate = store.insertCompletion(input());
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(first.completion.id, duplicate.completion.id);
    assert.equal(store.list().length, 1);
    assert.match(first.completion.tests[0].output, /<redacted>/);
    assert.match(first.completion.git.diff, /<redacted>/);
  } finally {
    store.close();
  }
});

test("instruction claim is atomic and creates a child iteration", () => {
  const store = createStore();
  try {
    const parent = store.insertCompletion(input()).completion;
    assert.equal(parent.iteration, 0);
    assert.equal(store.claimInstruction(parent.id, "Fix the tests").status, "sending_instruction");
    assert.equal(store.completeInstruction(parent.id).status, "instruction_sent");
    assert.throws(() => store.claimInstruction(parent.id, "Duplicate"), /cannot receive/);

    const child = store.insertCompletion(
      input({ eventKey: "session-1:message-2", assistantMessageId: "message-2" }),
    ).completion;
    assert.equal(child.parentId, parent.id);
    assert.equal(child.rootId, parent.id);
    assert.equal(child.iteration, 1);
    assert.equal(store.get(parent.id).status, "superseded");
  } finally {
    store.close();
  }
});

test("iteration limit blocks another instruction", () => {
  const store = createStore();
  try {
    const parent = store.insertCompletion(input({ maxIterations: 1 })).completion;
    store.claimInstruction(parent.id, "one");
    store.completeInstruction(parent.id);
    const child = store.insertCompletion(
      input({
        eventKey: "session-1:message-2",
        assistantMessageId: "message-2",
        maxIterations: 99,
      }),
    ).completion;
    assert.equal(child.iteration, 1);
    assert.equal(child.maxIterations, 1);
    assert.throws(() => store.claimInstruction(child.id, "two"), /iteration limit/i);
  } finally {
    store.close();
  }
});

test("review, stop, and audit records are persisted", () => {
  const store = createStore();
  try {
    const completion = store.insertCompletion(input()).completion;
    assert.equal(store.markTriggered(completion.id).triggeredAt !== null, true);
    assert.equal(
      store.markReviewed(completion.id, "approved", "TOKEN=abcdefghijklmnop").status,
      "reviewed",
    );
    assert.match(store.get(completion.id).review.summary, /<redacted>/);
    assert.throws(() => store.stop(completion.id, "Manual stop"), /cannot be reviewed/);
    const stopped = store.insertCompletion(
      input({ eventKey: "session-2:message-1", sessionId: "session-2" }),
    ).completion;
    assert.equal(store.stop(stopped.id, "Manual stop").status, "stopped");
    const audit = store.auditEntries(completion.id);
    assert.ok(audit.some((entry) => entry.action === "completion_received"));
    assert.ok(audit.some((entry) => entry.action === "review_recorded"));
  } finally {
    store.close();
  }
});

test("legacy database rows are migrated with unique review capability tokens", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-store-legacy-"));
  const databasePath = path.join(directory, "bridge.sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE completions (
      id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      root_id TEXT NOT NULL,
      parent_id TEXT,
      session_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      worktree TEXT NOT NULL,
      assistant_text TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      max_iterations INTEGER NOT NULL,
      git_json TEXT,
      tests_json TEXT,
      review_json TEXT,
      last_instruction TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      triggered_at TEXT
    );
  `);
  legacy.prepare(`
    INSERT INTO completions (
      id, event_key, root_id, session_id, assistant_message_id, project_dir, worktree,
      assistant_text, completed_at, status, iteration, max_iterations, tests_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "00000000-0000-4000-8000-000000000001",
    "legacy:event",
    "00000000-0000-4000-8000-000000000001",
    "session",
    "message",
    directory,
    directory,
    "done",
    "2026-07-25T00:00:00.000Z",
    "pending",
    0,
    3,
    "[]",
    "2026-07-25T00:00:00.000Z",
    "2026-07-25T00:00:00.000Z",
  );
  legacy.close();

  const store = new CompletionStore(databasePath);
  try {
    const completion = store.get("00000000-0000-4000-8000-000000000001");
    assert.match(completion.reviewToken, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(store.getByReviewToken(completion.reviewToken).id, completion.id);
  } finally {
    store.close();
  }
});
