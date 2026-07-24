export class ReviewOrchestrator {
  constructor({ store, reviewer, mimoClient, desktop, config, logger } = {}) {
    this.store = store;
    this.reviewer = reviewer;
    this.mimoClient = mimoClient;
    this.desktop = desktop;
    this.config = config;
    this.logger = logger;
  }

  async recoverPending({ limit = 20 } = {}) {
    if (this.config.reviewMode === "none") return [];
    const pending = this.store.list({ statuses: ["pending"], limit }).reverse();
    const results = [];
    for (const completion of pending) {
      if (this.config.reviewMode === "desktop" && completion.triggeredAt) continue;
      try {
        results.push(await this.handleNewCompletion(completion));
      } catch (error) {
        this.logger?.error("Pending completion recovery failed", {
          completionId: completion.id,
          error: error.message,
        });
      }
    }
    return results;
  }

  async handleNewCompletion(completion) {
    switch (this.config.reviewMode) {
      case "desktop":
        await this.desktop.triggerReview(completion);
        return this.store.markTriggered(completion.id);
      case "api":
        return this.runApiReview(completion.id);
      case "hybrid": {
        const reviewed = await this.runApiReview(completion.id);
        await this.desktop.triggerReview(reviewed, { statusOnly: true });
        return this.store.markTriggered(completion.id);
      }
      case "none":
      default:
        return completion;
    }
  }

  async runApiReview(completionId) {
    let completion = this.store.get(completionId);
    if (!completion) throw new Error("Completion not found.");
    if (!this.reviewer) throw new Error("OpenAI reviewer is not configured.");

    this.store.setStatus(completion.id, "reviewing");
    try {
      const review = await this.reviewer.review(completion);
      completion = this.store.setReview(completion.id, {
        ...review,
        source: "openai_api",
        reviewedAt: new Date().toISOString(),
      });

      if (review.decision === "approve") {
        return this.store.setStatus(completion.id, "reviewed");
      }

      if (review.decision === "ask_user") {
        const waiting = this.store.setStatus(completion.id, "waiting_user");
        if (this.config.desktopEnabled) await this.desktop.triggerReview(waiting, { statusOnly: true });
        return waiting;
      }

      if (completion.iteration >= completion.maxIterations) {
        const waiting = this.store.setStatus(completion.id, "waiting_user", "iteration_limit");
        if (this.config.desktopEnabled) await this.desktop.triggerReview(waiting, { statusOnly: true });
        return waiting;
      }

      this.store.claimInstruction(completion.id, review.instruction);
      try {
        await this.mimoClient.sendInstruction(completion.sessionId, review.instruction);
        return this.store.completeInstruction(completion.id);
      } catch (error) {
        this.store.failInstruction(completion.id, error.message);
        throw error;
      }
    } catch (error) {
      this.logger?.error("Automatic review failed", {
        completionId,
        error: error.message,
      });
      this.store.setStatus(completionId, "waiting_user", error.message);
      throw error;
    }
  }
}
