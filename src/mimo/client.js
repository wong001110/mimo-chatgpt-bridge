export class MimoClient {
  constructor({ baseUrl, logger, clientFactory } = {}) {
    this.baseUrl = baseUrl;
    this.logger = logger;
    this.clientFactory = clientFactory;
    this.clientPromise = null;
  }

  async #client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        if (this.clientFactory) return this.clientFactory(this.baseUrl);
        const sdk = await import("@mimo-ai/sdk");
        return sdk.createOpencodeClient({ baseUrl: this.baseUrl });
      })();
    }
    return this.clientPromise;
  }

  async health() {
    const client = await this.#client();
    const result = await client.global.health();
    return result?.data ?? result;
  }

  async sendInstruction(sessionId, instruction) {
    const client = await this.#client();
    this.logger?.info("Sending follow-up instruction to MiMoCode", { sessionId });
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: instruction }],
      },
    });
    if (result?.error) {
      throw new Error(result.error.message || "MiMoCode rejected the instruction.");
    }
    return result?.data ?? result;
  }
}
