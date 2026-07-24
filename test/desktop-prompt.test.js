import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopReviewPrompt } from "../src/desktop/prompt.js";

test("desktop prompt pins the completion and one-action policy", () => {
  const prompt = buildDesktopReviewPrompt(
    {
      id: "00000000-0000-4000-8000-000000000000",
      sessionId: "session",
      iteration: 1,
      maxIterations: 3,
      projectDir: "/project",
      reviewToken: "review_token_abcdefghijklmnop",
    },
    "http://127.0.0.1:8787",
  );
  assert.match(prompt, /^MiMoCode has completed/);
  assert.match(prompt, /00000000-0000-4000-8000-000000000000/);
  assert.match(prompt, /submit exactly one action/i);
  assert.match(prompt, /Do not invent test results/);
  assert.match(prompt, /http:\/\/127\.0\.0\.1:8787\/review\/review_token_/);
  assert.doesNotMatch(prompt, /@MiMo Bridge/);
});
