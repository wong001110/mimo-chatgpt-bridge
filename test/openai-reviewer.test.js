import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIReviewer } from "../src/review/openai-reviewer.js";

const completion = {
  id: "00000000-0000-4000-8000-000000000000",
  rootId: "00000000-0000-4000-8000-000000000000",
  parentId: null,
  sessionId: "session",
  assistantMessageId: "message",
  projectDir: "/project",
  worktree: "/project",
  assistantText: "done",
  completedAt: new Date().toISOString(),
  status: "pending",
  iteration: 0,
  maxIterations: 3,
  git: null,
  tests: [],
  review: null,
  lastInstruction: null,
};

test("OpenAI reviewer uses Responses structured output without storage", async () => {
  let request;
  const reviewer = new OpenAIReviewer({
    apiKey: "unused",
    model: "gpt-5",
    clientFactory: () => ({
      responses: {
        async create(input) {
          request = input;
          return {
            output_text: JSON.stringify({
              decision: "request_changes",
              summary: "One issue",
              instruction: "Add a regression test",
            }),
          };
        },
      },
    }),
  });
  const result = await reviewer.review(completion);
  assert.equal(result.decision, "request_changes");
  assert.equal(request.model, "gpt-5");
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
});

test("OpenAI reviewer rejects invalid request_changes output", async () => {
  const reviewer = new OpenAIReviewer({
    model: "gpt-5",
    clientFactory: () => ({
      responses: {
        async create() {
          return {
            output_text: JSON.stringify({
              decision: "request_changes",
              summary: "Issue",
              instruction: "",
            }),
          };
        },
      },
    }),
  });
  await assert.rejects(() => reviewer.review(completion), /non-empty instruction/);
});
