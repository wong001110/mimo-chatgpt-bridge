import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { redactSecrets, redactValue } from "../security.js";

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventKey: row.event_key,
    rootId: row.root_id,
    parentId: row.parent_id,
    sessionId: row.session_id,
    assistantMessageId: row.assistant_message_id,
    projectDir: row.project_dir,
    worktree: row.worktree,
    assistantText: row.assistant_text,
    completedAt: row.completed_at,
    status: row.status,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    git: parseJson(row.git_json, null),
    tests: parseJson(row.tests_json, []),
    review: parseJson(row.review_json, null),
    lastInstruction: row.last_instruction,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    triggeredAt: row.triggered_at,
    reviewToken: row.review_token,
  };
}

export class CompletionStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS completions (
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
        triggered_at TEXT,
        review_token TEXT,
        FOREIGN KEY(parent_id) REFERENCES completions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_completions_status_created
        ON completions(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_completions_session_created
        ON completions(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        completion_id TEXT,
        action TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(completion_id) REFERENCES completions(id)
      );
    `);

    const columns = this.db.prepare("PRAGMA table_info(completions)").all();
    if (!columns.some((column) => column.name === "review_token")) {
      this.db.exec("ALTER TABLE completions ADD COLUMN review_token TEXT");
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_completions_review_token ON completions(review_token) WHERE review_token IS NOT NULL",
    );

    const missingTokens = this.db
      .prepare("SELECT id FROM completions WHERE review_token IS NULL")
      .all();
    const setToken = this.db.prepare("UPDATE completions SET review_token = ? WHERE id = ?");
    for (const row of missingTokens) {
      setToken.run(crypto.randomBytes(24).toString("base64url"), row.id);
    }
  }

  close() {
    this.db.close();
  }

  health() {
    const row = this.db.prepare("SELECT 1 AS ok").get();
    return row?.ok === 1;
  }

  audit(completionId, action, detail = null) {
    this.db
      .prepare(
        "INSERT INTO audit_log (completion_id, action, detail_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(completionId || null, action, detail ? JSON.stringify(detail) : null, now());
  }

  insertCompletion(input) {
    const existing = this.getByEventKey(input.eventKey);
    if (existing) return { completion: existing, inserted: false };

    const id = crypto.randomUUID();
    const reviewToken = crypto.randomBytes(24).toString("base64url");
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parentRow = this.db
        .prepare(
          `SELECT * FROM completions
           WHERE session_id = ? AND status = 'instruction_sent'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(input.sessionId);

      const parent = normalizeRow(parentRow);
      const parentId = parent?.id ?? null;
      const rootId = parent?.rootId ?? id;
      const iteration = parent ? parent.iteration + 1 : 0;
      const maxIterations = parent?.maxIterations ?? input.maxIterations;

      this.db
        .prepare(
          `INSERT INTO completions (
            id, event_key, root_id, parent_id, session_id, assistant_message_id,
            project_dir, worktree, assistant_text, completed_at, status,
            iteration, max_iterations, git_json, tests_json, review_token, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.eventKey,
          rootId,
          parentId,
          input.sessionId,
          input.assistantMessageId,
          input.projectDir,
          input.worktree,
          redactSecrets(input.assistantText),
          input.completedAt,
          iteration,
          maxIterations,
          input.git ? JSON.stringify(redactValue(input.git)) : null,
          JSON.stringify(redactValue(input.tests || [])),
          reviewToken,
          timestamp,
          timestamp,
        );

      if (parentId) {
        this.db
          .prepare("UPDATE completions SET status = 'superseded', updated_at = ? WHERE id = ?")
          .run(timestamp, parentId);
      }

      this.db.exec("COMMIT");
      const completion = this.get(id);
      this.audit(id, "completion_received", { parentId, iteration });
      return { completion, inserted: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      const raced = this.getByEventKey(input.eventKey);
      if (raced) return { completion: raced, inserted: false };
      throw error;
    }
  }

  get(id) {
    return normalizeRow(this.db.prepare("SELECT * FROM completions WHERE id = ?").get(id));
  }

  getByEventKey(eventKey) {
    return normalizeRow(
      this.db.prepare("SELECT * FROM completions WHERE event_key = ?").get(eventKey),
    );
  }

  getByReviewToken(reviewToken) {
    if (!reviewToken) return null;
    return normalizeRow(
      this.db.prepare("SELECT * FROM completions WHERE review_token = ?").get(reviewToken),
    );
  }

  list({ statuses = [], limit = 20 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    if (statuses.length === 0) {
      return this.db
        .prepare("SELECT * FROM completions ORDER BY created_at DESC LIMIT ?")
        .all(safeLimit)
        .map(normalizeRow);
    }
    const placeholders = statuses.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM completions WHERE status IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...statuses, safeLimit)
      .map(normalizeRow);
  }

  markTriggered(id) {
    const timestamp = now();
    this.db
      .prepare("UPDATE completions SET triggered_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, id);
    this.audit(id, "desktop_triggered");
    return this.get(id);
  }

  setStatus(id, status, detail = null) {
    this.db
      .prepare("UPDATE completions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now(), id);
    this.audit(id, "status_changed", { status, detail });
    return this.get(id);
  }

  setReview(id, review, status = null) {
    const timestamp = now();
    if (status) {
      this.db
        .prepare(
          "UPDATE completions SET review_json = ?, status = ?, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(redactValue(review)), status, timestamp, id);
    } else {
      this.db
        .prepare("UPDATE completions SET review_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(redactValue(review)), timestamp, id);
    }
    this.audit(id, "review_recorded", review);
    return this.get(id);
  }

  claimInstruction(id, instruction) {
    const safeInstruction = redactSecrets(instruction);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const completion = this.get(id);
      if (!completion) throw new Error("Completion not found.");
      if (!["pending", "waiting_user", "reviewing"].includes(completion.status)) {
        throw new Error(`Completion cannot receive an instruction in status ${completion.status}.`);
      }
      if (completion.iteration >= completion.maxIterations) {
        throw new Error(
          `Automatic iteration limit reached (${completion.iteration}/${completion.maxIterations}).`,
        );
      }
      const result = this.db
        .prepare(
          `UPDATE completions
           SET status = 'sending_instruction', last_instruction = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'waiting_user', 'reviewing')`,
        )
        .run(safeInstruction, now(), id);
      if (result.changes !== 1) throw new Error("Completion instruction was claimed elsewhere.");
      this.db.exec("COMMIT");
      this.audit(id, "instruction_claimed");
      return this.get(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeInstruction(id) {
    return this.setStatus(id, "instruction_sent");
  }

  failInstruction(id, errorMessage) {
    this.db
      .prepare("UPDATE completions SET status = 'pending', updated_at = ? WHERE id = ?")
      .run(now(), id);
    this.audit(id, "instruction_failed", { error: errorMessage });
    return this.get(id);
  }

  applyDecision(id, review, status) {
    const actionable = new Set(["pending", "reviewing", "waiting_user"]);
    const safeReview = redactValue(review);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const completion = this.get(id);
      if (!completion) throw new Error("Completion not found.");
      if (completion.status === status && completion.review?.verdict === safeReview.verdict) {
        this.db.exec("COMMIT");
        return completion;
      }
      if (!actionable.has(completion.status)) {
        throw new Error(`Completion cannot be reviewed in status ${completion.status}.`);
      }
      const timestamp = now();
      const result = this.db
        .prepare(
          `UPDATE completions
           SET review_json = ?, status = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'reviewing', 'waiting_user')`,
        )
        .run(JSON.stringify(safeReview), status, timestamp, id);
      if (result.changes !== 1) throw new Error("Completion decision was claimed elsewhere.");
      this.audit(id, "review_recorded", safeReview);
      this.db.exec("COMMIT");
      return this.get(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markReviewed(id, verdict, summary, source = "chatgpt_mcp") {
    if (!["approved", "needs_user"].includes(verdict)) {
      throw new Error("Review verdict must be approved or needs_user.");
    }
    return this.applyDecision(
      id,
      { verdict, summary, reviewedAt: now(), source },
      verdict === "approved" ? "reviewed" : "waiting_user",
    );
  }

  stop(id, reason, source = "manual") {
    return this.applyDecision(
      id,
      { verdict: "stopped", summary: reason, reviewedAt: now(), source },
      "stopped",
    );
  }

  auditEntries(id, limit = 100) {
    return this.db
      .prepare(
        "SELECT action, detail_json, created_at FROM audit_log WHERE completion_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(id, Math.min(Math.max(limit, 1), 500))
      .map((row) => ({
        action: row.action,
        detail: parseJson(row.detail_json, null),
        createdAt: row.created_at,
      }));
  }
}
