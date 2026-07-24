import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, parseEnvText } from "../src/config.js";

test("parseEnvText handles comments, quotes, and embedded newline escapes", () => {
  const parsed = parseEnvText(`# ignored\nA=1\nB="two words"\nC='three'\nD=line\\nnext\n`);
  assert.deepEqual(parsed, { A: "1", B: "two words", C: "three", D: "line\nnext" });
});

test("loadConfig validates modes and secrets", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-config-"));
  const base = {
    MIMO_BRIDGE_TOKEN: "a".repeat(32),
    MCP_PATH_TOKEN: "b".repeat(32),
    REVIEW_MODE: "desktop",
    MIMO_ALLOWED_ROOTS: [path.join(cwd, "one"), path.join(cwd, "two")].join(path.delimiter),
  };
  const config = loadConfig({ cwd, env: base });
  assert.equal(config.reviewMode, "desktop");
  assert.equal(config.allowedRoots.length, 2);
  assert.equal(config.mcpPath, `/mcp/${"b".repeat(32)}`);
  assert.equal(config.reviewBaseUrl, "http://127.0.0.1:8787");
  assert.throws(
    () => loadConfig({ cwd, env: { ...base, REVIEW_MODE: "invalid" } }),
    /REVIEW_MODE/,
  );
  assert.throws(
    () => loadConfig({ cwd, env: { ...base, MIMO_BRIDGE_TOKEN: "short" } }),
    /24 characters/,
  );
  assert.throws(
    () => loadConfig({ cwd, env: { ...base, MCP_PATH_TOKEN: "bad/token".repeat(4) } }),
    /only letters/,
  );
});


test("loadConfig uses store-only and desktop-off safe defaults", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-config-default-"));
  const config = loadConfig({ cwd, env: {}, strict: false });
  assert.equal(config.reviewMode, "none");
  assert.equal(config.desktopEnabled, false);
});
