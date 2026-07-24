import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  isPathWithinRoots,
  limitUtf8,
  readBearerToken,
  redactSecrets,
  redactValue,
  secureEqual,
  verifyBearer,
} from "../src/security.js";

test("bearer helpers use exact token matching", () => {
  assert.equal(readBearerToken("Bearer abc123"), "abc123");
  assert.equal(readBearerToken("basic abc123"), "");
  assert.equal(secureEqual("same", "same"), true);
  assert.equal(secureEqual("same", "different"), false);
  assert.equal(verifyBearer("Bearer secret", "secret"), true);
  assert.equal(verifyBearer("Bearer secret2", "secret"), false);
  assert.equal(verifyBearer(undefined, ""), true);
});

test("limitUtf8 respects byte limits without corrupting multibyte text", () => {
  const result = limitUtf8("中文內容abcdef", 15, "...");
  assert.ok(Buffer.byteLength(result, "utf8") <= 15);
  assert.ok(result.endsWith("..."));
  assert.equal(result.includes("�"), false);
});

test("redactSecrets masks common credential shapes", () => {
  const input = [
    "OPENAI_API_KEY=sk-abcdefghijklmnop",
    "TOKEN: abcdefghijklmnop",
    "Authorization: Bearer abcdefghijklmnop",
    "ghp_abcdefghijklmnop",
  ].join("\n");
  const output = redactSecrets(input);
  assert.equal(output.includes("sk-abcdefghijklmnop"), false);
  assert.equal(output.includes("abcdefghijklmnop"), false);
  assert.match(output, /<redacted>/);
});

test("redactValue recursively sanitizes structured output", () => {
  const value = redactValue({ tests: [{ output: "TOKEN=abcdefghijklmnop" }] });
  assert.match(value.tests[0].output, /<redacted>/);
});

test("path allowlist accepts roots and descendants only", () => {
  const root = path.resolve("/tmp/projects");
  assert.equal(isPathWithinRoots(root, [root]), true);
  assert.equal(isPathWithinRoots(path.join(root, "child"), [root]), true);
  assert.equal(isPathWithinRoots(path.resolve("/tmp/projects-other"), [root]), false);
  assert.equal(isPathWithinRoots(path.resolve("/anywhere"), []), true);
});
