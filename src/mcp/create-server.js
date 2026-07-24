import { publicCompletion } from "../security.js";

function textResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

export function registerBridgeTools(server, z, { store, actions, config }) {
  server.registerTool(
    "bridge_status",
    {
      title: "MiMo Bridge status",
      description: "Check the local MiMoCode bridge status and review mode.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () =>
      textResult({
        healthy: store.health(),
        reviewMode: config.reviewMode,
        desktopEnabled: config.desktopEnabled,
        maxAutoIterations: config.maxAutoIterations,
      }),
  );

  server.registerTool(
    "list_mimo_completions",
    {
      title: "List MiMoCode completions",
      description: "List recent MiMoCode completion events awaiting review or recently handled.",
      inputSchema: {
        status: z
          .enum([
            "pending",
            "reviewing",
            "waiting_user",
            "sending_instruction",
            "instruction_sent",
            "superseded",
            "reviewed",
            "stopped",
            "all",
          ])
          .optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ status = "pending", limit = 20 }) => {
      const statuses = status === "all" ? [] : [status];
      const items = store
        .list({ statuses, limit })
        .map((item) => publicCompletion(item, { includeDiff: false }));
      return textResult(items);
    },
  );

  server.registerTool(
    "get_mimo_completion",
    {
      title: "Get MiMoCode completion",
      description:
        "Read one MiMoCode completion, including its report, Git status, diff, and review state.",
      inputSchema: {
        completionID: z.string().uuid(),
        includeDiff: z.boolean().optional(),
        includeAudit: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ completionID, includeDiff = true, includeAudit = false }) => {
      const completion = store.get(completionID);
      if (!completion) return textResult("Completion not found.", true);
      const result = publicCompletion(completion, { includeDiff });
      if (includeAudit) result.audit = store.auditEntries(completionID);
      return textResult(result);
    },
  );

  server.registerTool(
    "send_instruction_to_mimo",
    {
      title: "Send instruction to MiMoCode",
      description:
        "Send one precise follow-up implementation instruction to the MiMoCode session associated with a completion.",
      inputSchema: {
        completionID: z.string().uuid(),
        instruction: z.string().min(1).max(30_000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ completionID, instruction }) => {
      const completion = store.get(completionID);
      if (!completion) return textResult("Completion not found.", true);
      try {
        const updated = await actions.sendInstruction(completionID, instruction, {
          source: "chatgpt_mcp",
        });
        return textResult({
          accepted: true,
          completionID,
          sessionID: completion.sessionId,
          status: updated.status,
        });
      } catch (error) {
        return textResult(error.message, true);
      }
    },
  );

  server.registerTool(
    "mark_mimo_completion_reviewed",
    {
      title: "Mark MiMoCode completion reviewed",
      description: "Record the review verdict for a MiMoCode completion.",
      inputSchema: {
        completionID: z.string().uuid(),
        verdict: z.enum(["approved", "needs_user"]),
        summary: z.string().min(1).max(10_000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ completionID, verdict, summary }) => {
      if (!store.get(completionID)) return textResult("Completion not found.", true);
      try {
        const updated = actions.markReviewed(completionID, verdict, summary, {
          source: "chatgpt_mcp",
        });
        return textResult({ completionID, status: updated.status, verdict });
      } catch (error) {
        return textResult(error.message, true);
      }
    },
  );

  server.registerTool(
    "stop_mimo_loop",
    {
      title: "Stop MiMoCode loop",
      description:
        "Stop automatic follow-up for a completion because it is blocked, unsafe, or needs a user decision.",
      inputSchema: {
        completionID: z.string().uuid(),
        reason: z.string().min(1).max(10_000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ completionID, reason }) => {
      if (!store.get(completionID)) return textResult("Completion not found.", true);
      try {
        const updated = actions.stop(completionID, reason, { source: "chatgpt_mcp" });
        return textResult({ completionID, status: updated.status, reason });
      } catch (error) {
        return textResult(error.message, true);
      }
    },
  );

  return server;
}

export async function createMcpServer(dependencies) {
  const [{ McpServer }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("zod"),
  ]);
  const server = new McpServer({ name: "mimo-chatgpt-bridge", version: "0.1.0" });
  return registerBridgeTools(server, z, dependencies);
}
