import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  prepareWorkspace,
  discardWorkspace,
  reviewWorkspace,
  checkCommand,
  providerEnvironment,
} from "./workspace";
import type { Review, Session } from "./types";
import { Store } from "./store";
import { RequestError, workspacePath, textField } from "./security";
import { adapter, resolveBinary } from "./providers";

interface Running {
  child: ChildProcess;
  stop: (reason: "cancelled" | "timed_out" | "failed") => void;
  done: Promise<void>;
}
export class Runtime {
  private active = new Map<string, Running>();
  private shuttingDown = false;
  constructor(
    readonly store: Store,
    readonly root: string,
    private options: {
      command?: string;
      prefix?: string[];
      timeoutMs?: number;
      graceMs?: number;
      worktreeRoot?: string;
      /** bin directory of Arbeit-managed provider installs */
      managedBin?: string;
    } = {},
  ) {
    store.recover();
  }

  get isBusy() {
    return this.active.size > 0;
  }
  startNew(projectId: string, prompt: string, taskUrl: string | null = null) {
    const session = this.store.draftSession(projectId);
    session.taskUrl = taskUrl;
    const executionId = this.execute(session, prompt, true);
    return { session: this.store.session(session.id), executionId };
  }
  start(sessionId: string, prompt: string): string {
    return this.execute(this.store.session(sessionId), prompt);
  }
  private execute(session: Session, prompt: string, isNew = false): string {
    if (this.shuttingDown)
      throw new RequestError("Server is shutting down.", 503);
    prompt = textField(prompt, "objective", 32000);
    const sessionId = session.id;
    const project = this.store.project(session.projectId);
    if (workspacePath(this.root, project.path) !== project.path)
      throw new RequestError("Workspace path changed. Register it again.");
    const writing = session.mode === "workspace-write";
    if (writing && project.mode !== "workspace-write")
      throw new RequestError("Project editing permission was revoked.", 403);
    if (writing && this.isBusy)
      throw new RequestError(
        "Wait for the current execution before editing.",
        409,
      );
    const worktreeRoot =
      this.options.worktreeRoot ?? resolve(this.root, ".arbeit/worktrees");
    if (writing && isNew)
      Object.assign(
        session,
        prepareWorkspace(project.path, session.id, worktreeRoot),
      );
    if (
      writing &&
      (!session.workspace ||
        workspacePath(worktreeRoot, session.workspace) !==
          resolve(worktreeRoot, session.id))
    )
      throw new RequestError("Execution worktree is unavailable.");
    const provider = adapter(session.provider);
    let schema: { json: string; path: string } | undefined;
    if (writing) {
      mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
      const json = JSON.stringify({
        type: "object",
        additionalProperties: false,
        required: ["outcome", "summary", "question"],
        properties: {
          outcome: {
            type: "string",
            enum: ["ready_for_review", "needs_input", "blocked"],
          },
          summary: { type: "string" },
          question: { type: ["string", "null"] },
        },
      });
      schema = { json, path: resolve(worktreeRoot, "result-schema.json") };
      writeFileSync(schema.path, json, { mode: 0o600 });
    }
    let executionId: string;
    try {
      executionId = this.store.begin(session, project.model, prompt, isNew);
    } catch (error) {
      if (writing && isNew)
        discardWorkspace(project.path, session.id, worktreeRoot);
      throw error;
    }
    let contract: Pick<Review, "outcome" | "summary" | "question"> | null =
      null;
    const checkResults = new Map<
      string,
      { exitCode: number | null; status: string }
    >();
    const instruction = writing
      ? `${prompt}\n\nArbeit execution policy: work only in this isolated worktree. Do not commit, push, merge or change the source checkout. Use the provider sandbox; unavailable permissions must produce a blocked result. Run each required check as its own shell command, exactly as listed below. Do not combine commands or change checks to make them pass. Trello tracking is handled by Arbeit; do not attempt to access its credentials. If a meaningful decision is required, return outcome needs_input with a concrete question. Otherwise return ready_for_review only after implementation and all checks succeed. Checks: ${project.checks.map((name) => (name === "test" ? "npm test" : `npm run ${name}`)).join(", ") || "none configured"}.`
      : prompt;

    let success = false,
      providerFailed = false,
      invalid = false,
      buffer = "",
      total = 0;
    let stopped: "cancelled" | "timed_out" | "failed" | null = null;
    const decoder = new StringDecoder("utf8");
    const parse = provider.parser();
    const readContract = (value: unknown) => {
      const candidate = value as Record<string, unknown> | null;
      if (
        candidate &&
        ["ready_for_review", "needs_input", "blocked"].includes(
          candidate.outcome as string,
        ) &&
        typeof candidate.summary === "string" &&
        (candidate.question === null || typeof candidate.question === "string")
      ) {
        contract = {
          outcome: candidate.outcome as Review["outcome"],
          summary: candidate.summary.slice(0, 16000),
          question:
            (candidate.question as string | null)?.slice(0, 4000) ?? null,
        };
        return true;
      }
      return false;
    };
    const child = spawn(
      this.options.command ??
        resolveBinary(provider.id, this.options.managedBin) ??
        provider.binary,
      [
        ...(this.options.prefix ?? []),
        ...provider.args({
          providerSessionId: session.providerSessionId,
          model: project.model,
          mode: session.mode,
          checks: project.checks,
          schema,
        }),
      ],
      {
        cwd: session.workspace ?? project.path,
        env: providerEnvironment(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(name);
        else process.kill(-child.pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const stop = (reason: "cancelled" | "timed_out" | "failed") => {
      if (stopped) return;
      stopped = reason;
      signal("SIGTERM");
      escalation = setTimeout(
        () => signal("SIGKILL"),
        this.options.graceMs ?? 2000,
      );
    };
    const consume = (line: string) => {
      if (!line.trim() || invalid || stopped) return;
      try {
        const observed = parse(JSON.parse(line));
        if (observed.providerSessionId)
          this.store.providerId(sessionId, observed.providerSessionId);
        if (observed.succeeded) success = true;
        if (observed.failed) providerFailed = true;
        if (writing && observed.command) {
          const name = checkCommand(observed.command.text, project.checks);
          if (name) {
            const status = observed.command.ok ? "passed" : "failed";
            checkResults.set(name, {
              exitCode: observed.command.exitCode,
              status,
            });
            this.store.event(sessionId, executionId, "check.completed", {
              name,
              status,
              exitCode: observed.command.exitCode,
            });
          }
        }
        if (
          writing &&
          observed.structured !== undefined &&
          !contract &&
          readContract(observed.structured)
        )
          this.store.event(sessionId, executionId, "message.agent", {
            providerItemId: "structured-result",
            text: (contract as unknown as Review).summary,
          });
        for (const e of observed.events) {
          if (
            writing &&
            provider.contractInMessage &&
            e.type === "message.agent"
          ) {
            try {
              if (readContract(JSON.parse(String(e.data.text))))
                e.data.text = (contract as unknown as Review).summary;
            } catch {
              /* Intermediate assistant text is not a decision contract. */
            }
          }
          this.store.event(sessionId, executionId, e.type, e.data);
        }
      } catch {
        invalid = true;
        stop("failed");
      }
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      total += chunk.length;
      buffer += decoder.write(chunk);
      if (total > 4 * 1024 * 1024 || buffer.length > 1024 * 1024) {
        invalid = true;
        stop("failed");
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr!.on("data", () => {}); // Drain without retaining potentially sensitive diagnostics.
    child.stdin!.on("error", () => {});
    child.stdin!.end(instruction);
    const deadline = setTimeout(
      () => stop("timed_out"),
      this.options.timeoutMs ?? 180_000,
    );
    let resolveDone: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let spawnError = false;
    child.on("error", () => {
      spawnError = true;
    });
    child.on("close", (code, terminationSignal) => {
      clearTimeout(deadline);
      // A descendant may outlive the provider even when its own pipes are closed.
      if (stopped) signal("SIGKILL");
      if (escalation) clearTimeout(escalation);
      buffer += decoder.end();
      consume(buffer);
      const status =
        stopped ??
        (code === 0 && success && !providerFailed && !invalid
          ? "completed"
          : "failed");
      if (writing) {
        const checks = project.checks.map((name) => ({
          name,
          status: checkResults.get(name)?.status ?? "not_run",
          exitCode: checkResults.get(name)?.exitCode ?? null,
        })) as Review["checks"];
        const review: Review = {
          outcome: "blocked",
          summary: "Provider did not return a valid structured outcome.",
          question: null,
          checks,
          diff: "",
          files: [],
          workspace: session.workspace,
          baseCommit: session.baseCommit,
          truncated: false,
        };
        try {
          Object.assign(review, reviewWorkspace(session), contract ?? {});
          if (status !== "completed") {
            review.outcome = "blocked";
            review.summary = `Execution ${status}. Inspect changes before continuing.`;
          } else if (
            review.outcome === "ready_for_review" &&
            checks.some((check) => check.status !== "passed")
          ) {
            review.outcome = "blocked";
            review.summary =
              "Required checks have not all been observed passing.";
          } else if (
            review.outcome === "needs_input" &&
            !review.question?.trim()
          ) {
            review.outcome = "blocked";
            review.summary = "The provider requested input without a question.";
          }
        } catch {
          review.outcome = "blocked";
          review.summary =
            "Changes could not be captured. Inspect the retained worktree.";
        }
        this.store.review(executionId, review);
        this.store.event(sessionId, executionId, "review.ready", {
          outcome: review.outcome,
          summary: review.summary,
          files: review.files,
          checks: review.checks,
        });
        if (review.outcome === "needs_input")
          this.store.event(sessionId, executionId, "interaction.requested", {
            question: review.question,
          });
      }
      this.store.finish(sessionId, executionId, status, {
        exitCode: code,
        signal: terminationSignal,
        ...(status === "failed"
          ? {
              message: spawnError
                ? `${provider.label} could not start. Check installation and login.`
                : invalid
                  ? "Provider returned an invalid or oversized event stream."
                  : `${provider.label} execution failed. Check provider login, model access and workspace permissions.`,
            }
          : {}),
      });
      this.active.delete(sessionId);
      resolveDone!();
    });
    this.active.set(sessionId, { child, stop, done });
    return executionId;
  }
  cancel(sessionId: string) {
    this.store.session(sessionId);
    const active = this.active.get(sessionId);
    if (!active) throw new RequestError("This session is not running.", 409);
    active.stop("cancelled");
  }
  async shutdown() {
    this.shuttingDown = true;
    const running = [...this.active.values()];
    for (const item of running) item.stop("cancelled");
    await Promise.all(running.map((item) => item.done));
  }
}
