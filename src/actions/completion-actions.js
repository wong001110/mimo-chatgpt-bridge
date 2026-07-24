export class CompletionActions {
  constructor({ store, mimoClient, logger } = {}) {
    this.store = store;
    this.mimoClient = mimoClient;
    this.logger = logger;
  }

  get(completionID) {
    const completion = this.store.get(completionID);
    if (!completion) throw new Error("Completion not found.");
    return completion;
  }

  async sendInstruction(completionID, instruction, { source = "chatgpt_mcp" } = {}) {
    const completion = this.get(completionID);
    try {
      this.store.claimInstruction(completionID, instruction);
      this.store.audit(completionID, "instruction_requested", { source });
      await this.mimoClient.sendInstruction(completion.sessionId, instruction);
      const updated = this.store.completeInstruction(completionID);
      this.logger?.info("Instruction sent to MiMoCode", { completionID, source });
      return updated;
    } catch (error) {
      if (this.store.get(completionID)?.status === "sending_instruction") {
        this.store.failInstruction(completionID, error.message);
      }
      throw error;
    }
  }

  markReviewed(completionID, verdict, summary, { source = "chatgpt_mcp" } = {}) {
    this.get(completionID);
    return this.store.markReviewed(completionID, verdict, summary, source);
  }

  stop(completionID, reason, { source = "chatgpt_mcp" } = {}) {
    this.get(completionID);
    this.store.audit(completionID, "stop_requested", { source });
    return this.store.stop(completionID, reason, source);
  }
}
