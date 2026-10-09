import { Runtime } from "./runtime";
import { RequestError } from "./security";
import { taskObjective, type TaskSource } from "./trello";
import type { Project, TaskReceipt, TrelloCard, WorkflowConfig } from "./types";

export class Dispatcher {
  private ticking = false;
  private claiming = false;
  private nextPoll = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    readonly runtime: Runtime,
    readonly source: TaskSource,
    private pollMs = 15_000,
  ) {
    for (const project of runtime.store.projects()) {
      if (project.workflow?.enabled)
        this.pause(
          project.id,
          "Server restarted. Review previous work before rearming.",
        );
    }
    for (const receipt of runtime.store.receipts()) {
      if (["claimed", "running"].includes(receipt.status))
        runtime.store.receipt(
          receipt.id,
          "paused",
          receipt.sessionId,
          "Server restarted. Execution will not be replayed.",
        );
    }
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 1000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    while (this.ticking)
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  pause(projectId: string, reason = "Paused by user.") {
    const config = this.runtime.store.project(projectId).workflow;
    if (config)
      this.runtime.store.workflow(projectId, {
        ...config,
        enabled: false,
        reason,
      });
  }
  async configure(project: Project, config: WorkflowConfig) {
    if (
      this.runtime.store
        .receipts(project.id)
        .some((receipt) => receipt.status !== "reported")
    )
      throw new RequestError(
        "Resolve existing task receipts before changing the workflow.",
        409,
      );
    const [lists, labels] = await Promise.all([
      this.source.lists(config.boardId),
      this.source.labels(config.boardId),
    ]);
    if (
      new Set([config.readyListId, config.runningListId, config.reviewListId])
        .size !== 3 ||
      ![config.readyListId, config.runningListId, config.reviewListId].every(
        (id) => lists.some((list) => list.id === id),
      ) ||
      !labels.some((label) => label.id === config.labelId)
    )
      throw new RequestError(
        "Choose three distinct lists and an eligibility label on this board.",
      );
    this.runtime.store.workflow(project.id, {
      ...config,
      enabled: false,
      remaining: 0,
      reason: "Configured. Arm dispatch to start eligible work.",
    });
  }
  async arm(projectId: string, limit: number) {
    const project = this.runtime.store.project(projectId);
    if (!this.source.configured)
      throw new RequestError("Trello credentials are not configured.", 503);
    if (
      !project.workflow ||
      project.mode !== "workspace-write" ||
      !project.checks.length
    )
      throw new RequestError(
        "Configure editing, required checks and a Trello workflow before arming.",
      );
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new RequestError("Choose a batch limit between 1 and 10.");
    if (
      this.runtime.store
        .receipts(projectId)
        .some((receipt) => receipt.status === "paused")
    )
      throw new RequestError(
        "Resolve the paused task before starting another batch.",
        409,
      );
    this.runtime.store.workflow(projectId, {
      ...project.workflow,
      enabled: true,
      remaining: limit,
      reason: null,
    });
  }
  private eligible(card: TrelloCard, config: WorkflowConfig) {
    return (
      !card.closed &&
      card.idBoard === config.boardId &&
      card.idList === config.readyListId &&
      card.idLabels.includes(config.labelId)
    );
  }
  async run(projectId: string, cardId: string, automatic = false) {
    if (this.claiming)
      throw new RequestError("A task is already being claimed.", 409);
    this.claiming = true;
    try {
      return await this.launch(projectId, cardId, automatic);
    } finally {
      this.claiming = false;
    }
  }
  private async launch(projectId: string, cardId: string, automatic: boolean) {
    const project = this.runtime.store.project(projectId);
    const config = project.workflow;
    if (!config || project.mode !== "workspace-write" || !project.checks.length)
      throw new RequestError(
        "Configure project editing, checks and Trello first.",
      );
    if (this.runtime.isBusy)
      throw new RequestError("An execution is already running.", 409);
    if (
      this.runtime.store.receipts().some((receipt) => receipt.cardId === cardId)
    )
      throw new RequestError(
        "This card already has an execution receipt. Open its session to continue.",
        409,
      );
    const card = await this.source.card(cardId);
    if (automatic && !this.runtime.store.project(projectId).workflow?.enabled)
      return;
    if (!this.eligible(card, config))
      throw new RequestError(
        "Card must be open, in the ready list and carry the configured eligibility label.",
        409,
      );
    // Durable claim before external writes makes uncertain claims non-replayable.
    const receipt = this.runtime.store.claim(projectId, card.id, card.url);
    try {
      const objective = taskObjective(card);
      await this.source.move(card.id, config.runningListId);
      if (automatic && !this.runtime.store.project(projectId).workflow?.enabled)
        throw new RequestError(
          "Dispatch paused while claiming the card. Reconcile its Trello state.",
          409,
        );
      // Recheck after awaits so a concurrent manual run cannot overlap dispatch.
      if (this.runtime.isBusy)
        throw new RequestError(
          "An execution started while claiming the card.",
          409,
        );
      const result = this.runtime.startNew(projectId, objective, card.url);
      this.runtime.store.receipt(receipt.id, "running", result.session.id);
      return result;
    } catch (error) {
      const message =
        error instanceof RequestError
          ? error.message
          : "Task could not start. Review the card and workspace.";
      this.runtime.store.receipt(receipt.id, "paused", null, message);
      this.pause(projectId, message);
      throw new RequestError(message, 409);
    }
  }
  private async report(receipt: TaskReceipt) {
    if (!receipt.sessionId) return;
    const detail = this.runtime.store.detail(receipt.sessionId);
    const execution = detail.executions.at(-1);
    if (!execution || execution.status === "running") return;
    const project = this.runtime.store.project(receipt.projectId);
    const config = project.workflow;
    if (!config)
      throw new RequestError("Task workflow configuration is missing.");
    const review = execution.review;
    const ready =
      execution.status === "completed" &&
      review?.outcome === "ready_for_review" &&
      review.checks.length > 0 &&
      review.checks.every((check) => check.status === "passed");
    const message = `Execution: ${execution.status}\nOutcome: ${review?.outcome ?? "unavailable"}\n${review?.summary ?? "Inspect the retained execution before continuing."}\nChecks: ${review?.checks.map((check) => `${check.name}: ${check.status}`).join(", ") ?? "unavailable"}\nChanged files: ${review?.files.join(", ") || "none"}\nSession: ${receipt.sessionId}\nReview in the local Arbeit application. Changes have not been merged.${review?.question ? `\nQuestion: ${review.question}` : ""}`;
    await this.source.report(
      receipt.cardId,
      `${receipt.id}-${execution.id}`,
      message,
    );
    if (ready) {
      const card = await this.source.card(receipt.cardId);
      if (
        card.idList !== config.runningListId &&
        card.idList !== config.reviewListId
      )
        throw new RequestError(
          "Card moved outside the execution workflow. Review manually.",
        );
      if (card.idList !== config.reviewListId)
        await this.source.move(card.id, config.reviewListId);
      this.runtime.store.receipt(receipt.id, "reported", receipt.sessionId);
      if (config.remaining <= 0)
        this.pause(project.id, "Batch complete. Results are ready for review.");
    } else {
      this.runtime.store.receipt(
        receipt.id,
        "paused",
        receipt.sessionId,
        review?.question ?? review?.summary ?? `Execution ${execution.status}.`,
      );
      this.pause(
        project.id,
        review?.question ?? review?.summary ?? "Task requires attention.",
      );
    }
  }
  acknowledge(projectId: string, receiptId: string) {
    const receipt = this.runtime.store
      .receipts(projectId)
      .find((item) => item.id === receiptId);
    if (!receipt || receipt.status !== "paused" || receipt.sessionId)
      throw new RequestError(
        "Only an unresolved claim without an execution can be acknowledged.",
      );
    this.runtime.store.receipt(
      receipt.id,
      "reported",
      null,
      "Claim reconciled manually. This card will not be dispatched again.",
    );
  }
  async reconcile(projectId: string, receiptId: string) {
    const receipt = this.runtime.store
      .receipts(projectId)
      .find((item) => item.id === receiptId);
    if (!receipt?.sessionId)
      throw new RequestError(
        "This claim needs manual reconciliation in Trello; no execution was started.",
      );
    await this.report(receipt);
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const receipt of this.runtime.store
        .receipts()
        .filter((item) => item.status === "running")) {
        try {
          await this.report(receipt);
        } catch (error) {
          const message =
            error instanceof RequestError
              ? error.message
              : "Result reporting failed. Review before retrying.";
          this.runtime.store.receipt(
            receipt.id,
            "paused",
            receipt.sessionId,
            message,
          );
          this.pause(receipt.projectId, message);
        }
      }
      if (this.runtime.isBusy) return;
      const project = this.runtime.store
        .projects()
        .find((item) => item.workflow?.enabled && item.workflow.remaining > 0);
      if (!project?.workflow || Date.now() < this.nextPoll) return;
      this.nextPoll = Date.now() + this.pollMs;
      try {
        const cards = await this.source.cards(project.workflow.readyListId);
        if (!this.runtime.store.project(project.id).workflow?.enabled) return;
        const previous = new Set(
          this.runtime.store.receipts().map((receipt) => receipt.cardId),
        );
        const card = cards
          .filter(
            (item) =>
              this.eligible(item, project.workflow!) && !previous.has(item.id),
          )
          .sort((a, b) => a.pos - b.pos)[0];
        if (!card) return;
        const result = await this.run(project.id, card.id, true);
        if (!result) return;
        const current = this.runtime.store.project(project.id).workflow!;
        this.runtime.store.workflow(project.id, {
          ...current,
          remaining: current.remaining - 1,
        });
      } catch (error) {
        this.pause(
          project.id,
          error instanceof RequestError
            ? error.message
            : "Dispatch failed. Inspect task state.",
        );
      }
    } finally {
      this.ticking = false;
    }
  }
}
