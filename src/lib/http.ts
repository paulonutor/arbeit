import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  checkOrigin,
  RequestError,
  textField,
  workspacePath,
} from "./security";
import { Dispatcher } from "./dispatcher";
import { Trello, trelloId } from "./trello";
import { availableChecks } from "./workspace";
import type { Mode, WorkflowConfig } from "./types";
import { Runtime } from "./runtime";

async function body(c: Context): Promise<Record<string, unknown>> {
  if (!c.req.header("content-type")?.startsWith("application/json"))
    throw new RequestError("JSON body required.", 415);
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new RequestError("JSON body required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 40_000) {
        await reader.cancel();
        throw new RequestError("Request too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value;
  } catch {
    throw new RequestError("Invalid JSON.");
  }
}

export function api(runtime: Runtime, port: number, dispatcher?: Dispatcher) {
  const app = new Hono();
  const { store } = runtime;
  app.use("*", async (c, next) => {
    checkOrigin(
      { method: c.req.method, headers: Object.fromEntries(c.req.raw.headers) },
      port,
    );
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof RequestError
            ? error.message
            : "The request could not be completed.",
      },
      (error instanceof RequestError
        ? error.status
        : 500) as ContentfulStatusCode,
    ),
  );
  app.notFound((c) => c.json({ error: "Route not found." }, 404));
  app.get("/api/bootstrap", (c) =>
    c.json({
      projects: store.projects(),
      sessions: store.sessions(),
      workspaceRoot: runtime.root,
      trelloConfigured: dispatcher?.source.configured ?? false,
    }),
  );
  app.post("/api/projects", async (c) => {
    const input = await body(c);
    const model = input.model ? textField(input.model, "model", 100) : null;
    if (model && !/^[a-zA-Z0-9._-]+$/.test(model))
      throw new RequestError("Invalid model.");
    return c.json(
      store.addProject(
        textField(input.name, "project name"),
        workspacePath(
          runtime.root,
          textField(input.path, "workspace path", 4096),
        ),
        model,
      ),
      201,
    );
  });
  app.get("/api/projects/:id/settings", (c) => {
    const project = store.project(c.req.param("id"));
    return c.json({
      project,
      checks: availableChecks(project.path),
      receipts: store.receipts(project.id),
      trelloConfigured: dispatcher?.source.configured ?? false,
    });
  });
  app.post("/api/projects/:id/settings", async (c) => {
    if (runtime.isBusy)
      throw new RequestError(
        "Wait for the active execution before changing project policy.",
        409,
      );
    const project = store.project(c.req.param("id"));
    const input = await body(c);
    if (!["read-only", "workspace-write"].includes(String(input.mode)))
      throw new RequestError("Invalid execution policy.");
    const checks = input.checks;
    if (
      !Array.isArray(checks) ||
      !checks.every(
        (name) =>
          typeof name === "string" &&
          availableChecks(project.path).includes(name),
      )
    )
      throw new RequestError("Select available project checks.");
    const config = project.workflow
      ? {
          ...project.workflow,
          enabled: false,
          reason: "Project policy changed. Arm a new batch to continue.",
        }
      : null;
    return c.json(
      store.settings(
        project.id,
        input.mode as Mode,
        [...new Set(checks)] as string[],
        config,
      ),
    );
  });
  app.get("/api/trello/boards/:id", async (c) => {
    const source = dispatcher?.source ?? new Trello();
    const board = await source.board(c.req.param("id"));
    const id = trelloId(board.id);
    const [lists, labels] = await Promise.all([
      source.lists(id),
      source.labels(id),
    ]);
    return c.json({ board, lists, labels });
  });
  app.get("/api/projects/:id/board", async (c) => {
    const project = store.project(c.req.param("id"));
    if (!project.workflow || !dispatcher?.source.configured)
      return c.json({ configured: false, board: null, lists: [] });
    const source = dispatcher.source;
    const boardId = project.workflow.boardId;
    const [board, lists] = await Promise.all([
      source.board(boardId),
      source.lists(boardId),
    ]);
    const columns = await Promise.all(
      lists.map(async (list) => ({
        ...list,
        cards: (await source.cards(list.id))
          .filter(
            (card) =>
              !card.closed &&
              card.idBoard === boardId &&
              card.idList === list.id,
          )
          .sort((a, b) => a.pos - b.pos),
      })),
    );
    return c.json({ configured: true, board, lists: columns });
  });
  app.get("/api/projects/:id/tasks", async (c) => {
    const project = store.project(c.req.param("id"));
    if (!project.workflow || !dispatcher)
      return c.json({ cards: [], receipts: store.receipts(project.id) });
    const config = project.workflow;
    const cards = await dispatcher.source.cards(config.readyListId);
    return c.json({
      cards: cards.filter(
        (card) =>
          !card.closed &&
          card.idBoard === config.boardId &&
          card.idLabels.includes(config.labelId),
      ),
      receipts: store.receipts(project.id),
    });
  });
  app.post("/api/projects/:id/workflow", async (c) => {
    if (!dispatcher) throw new RequestError("Dispatcher unavailable.", 503);
    if (runtime.isBusy)
      throw new RequestError(
        "Wait for the active execution before changing workflow.",
        409,
      );
    const input = await body(c);
    const config = Object.fromEntries(
      [
        "boardId",
        "readyListId",
        "runningListId",
        "reviewListId",
        "labelId",
      ].map((name) => [name, trelloId(textField(input[name], name))]),
    ) as unknown as WorkflowConfig;
    await dispatcher.configure(store.project(c.req.param("id")), config);
    return c.json(store.project(c.req.param("id")));
  });
  app.post("/api/projects/:id/dispatch", async (c) => {
    if (!dispatcher) throw new RequestError("Dispatcher unavailable.", 503);
    const input = await body(c);
    if (input.action === "pause") dispatcher.pause(c.req.param("id"));
    else if (input.action === "arm")
      await dispatcher.arm(c.req.param("id"), Number(input.limit));
    else throw new RequestError("Invalid dispatcher action.");
    return c.json(store.project(c.req.param("id")));
  });
  app.post("/api/projects/:id/tasks", async (c) => {
    if (!dispatcher) throw new RequestError("Dispatcher unavailable.", 503);
    const input = await body(c);
    return c.json(
      await dispatcher.run(
        c.req.param("id"),
        trelloId(textField(input.cardId, "card ID")),
      ),
      202,
    );
  });
  app.post("/api/projects/:id/receipts/:receiptId", async (c) => {
    if (!dispatcher) throw new RequestError("Dispatcher unavailable.", 503);
    const input = await body(c);
    if (input.action === "acknowledge")
      dispatcher.acknowledge(c.req.param("id"), c.req.param("receiptId"));
    else if (input.action === "report")
      await dispatcher.reconcile(c.req.param("id"), c.req.param("receiptId"));
    else throw new RequestError("Invalid reconciliation action.");
    return c.json({ accepted: true });
  });
  // Creation is an execution command, never a persistent empty chat.
  app.post("/api/sessions", async (c) => {
    const input = await body(c);
    return c.json(
      runtime.startNew(
        textField(input.projectId, "project ID"),
        textField(input.text, "objective", 32000),
      ),
      202,
    );
  });
  app.get("/api/sessions/:id", (c) => c.json(store.detail(c.req.param("id"))));
  app.post("/api/sessions/:id/messages", async (c) => {
    const input = await body(c);
    const sessionId = c.req.param("id");
    const executionId = runtime.start(
      sessionId,
      textField(input.text, "instruction", 32000),
    );
    const receipt = store
      .receipts()
      .find((item) => item.sessionId === sessionId);
    if (receipt) store.receipt(receipt.id, "running", sessionId);
    return c.json({ executionId }, 202);
  });
  app.post("/api/sessions/:id/cancel", (c) => {
    runtime.cancel(c.req.param("id"));
    return c.json({ accepted: true }, 202);
  });
  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    store.session(id);
    const cursor = Number(
      c.req.header("last-event-id") ?? c.req.query("after") ?? "0",
    );
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new RequestError("Invalid event cursor.");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let after = cursor;
      let lastHeartbeat = Date.now();
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      while (!closed && !stream.closed) {
        for (const event of store.events(id, after)) {
          if (closed) break;
          await stream.writeSSE({
            id: String(event.id),
            data: JSON.stringify(event),
          });
          after = event.id;
        }
        if (Date.now() - lastHeartbeat >= 15_000) {
          await stream.write(": heartbeat\n\n");
          lastHeartbeat = Date.now();
        }
        await stream.sleep(250);
      }
    });
  });
  return app;
}
