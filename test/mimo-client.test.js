import assert from "node:assert/strict";
import test from "node:test";
import { MimoClient } from "../src/mimo/client.js";

test("MiMo client targets the existing session", async () => {
  const calls = [];
  const client = new MimoClient({
    baseUrl: "http://127.0.0.1:4096",
    clientFactory: (baseUrl) => {
      assert.equal(baseUrl, "http://127.0.0.1:4096");
      return {
        global: { health: async () => ({ data: { healthy: true } }) },
        session: {
          prompt: async (input) => {
            calls.push(input);
            return { data: { accepted: true } };
          },
        },
      };
    },
  });
  assert.deepEqual(await client.health(), { healthy: true });
  assert.deepEqual(await client.sendInstruction("session-id", "Continue"), { accepted: true });
  assert.deepEqual(calls, [
    {
      path: { id: "session-id" },
      body: { parts: [{ type: "text", text: "Continue" }] },
    },
  ]);
});

test("MiMo client surfaces SDK errors", async () => {
  const client = new MimoClient({
    baseUrl: "http://127.0.0.1:4096",
    clientFactory: () => ({
      session: { prompt: async () => ({ error: { message: "rejected" } }) },
    }),
  });
  await assert.rejects(() => client.sendInstruction("s", "x"), /rejected/);
});
