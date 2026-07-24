import { limitUtf8, publicCompletion, redactSecrets } from "../security.js";

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: {
      type: "string",
      enum: ["approve", "request_changes", "ask_user"],
    },
    summary: { type: "string" },
    instruction: { type: "string" },
  },
  required: ["decision", "summary", "instruction"],
};

function validateReview(value) {
  if (!value || typeof value !== "object") throw new Error("Reviewer returned no JSON object.");
  if (!["approve", "request_changes", "ask_user"].includes(value.decision)) {
    throw new Error(`Invalid reviewer decision: ${value.decision}`);
  }
  if (typeof value.summary !== "string" || typeof value.instruction !== "string") {
    throw new Error("Reviewer summary and instruction must be strings.");
  }
  if (value.decision === "request_changes" && !value.instruction.trim()) {
    throw new Error("request_changes requires a non-empty instruction.");
  }
  return {
    decision: value.decision,
    summary: redactSecrets(value.summary.trim()),
    instruction: redactSecrets(value.instruction.trim()),
  };
}

export class OpenAIReviewer {
  constructor({ apiKey, model, logger, clientFactory } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
    this.clientFactory = clientFactory;
    this.clientPromise = null;
  }

  async #client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        if (this.clientFactory) return this.clientFactory();
        const module = await import("openai");
        const OpenAI = module.default || module.OpenAI;
        return new OpenAI({ apiKey: this.apiKey });
      })();
    }
    return this.clientPromise;
  }

  async review(completion) {
    const client = await this.#client();
    const evidence = publicCompletion(completion, { includeDiff: true });
    const payload = limitUtf8(JSON.stringify(evidence, null, 2), 350_000);
    this.logger?.info("Requesting OpenAI review", { completionId: completion.id, model: this.model });

    const response = await client.responses.create({
      model: this.model,
      store: false,
      input: [
        {
          role: "system",
          content:
            "You are a strict coding completion reviewer. Judge only from supplied evidence. Do not invent test results, commits, pushes, or file contents. Request a precise next implementation step only when needed. Ask the user for credentials, destructive decisions, or ambiguous product choices.",
        },
        {
          role: "user",
          content: `Review this MiMoCode completion:\n\n${payload}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "mimo_completion_review",
          strict: true,
          schema: REVIEW_SCHEMA,
        },
      },
    });

    const raw = response.output_text;
    if (!raw) throw new Error("OpenAI reviewer returned empty output.");
    return validateReview(JSON.parse(raw));
  }
}
