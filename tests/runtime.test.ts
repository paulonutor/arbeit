import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/lib/store";
import { Runtime } from "../src/lib/runtime";
import { workspacePath, checkOrigin } from "../src/lib/security";
import { normalizeCodex, codexArgs } from "../src/lib/codex";
import { api } from "../src/lib/http";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";

function fixtureSession(store: Store, projectId: string) {
  const session = store.draftSession(projectId);
  store.db
    .prepare(
      "INSERT INTO sessions(id,projectId,title,provider,providerSessionId,createdAt) VALUES (?,?,?,?,?,?)",
    )
    .run(
      session.id,
      session.projectId,
      session.title,
      session.provider,
      session.providerSessionId,
      session.createdAt,
    );
  return session;
}
function setup(script: string, timeoutMs = 2000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arbeit-test-")));
  const fixture = join(root, "provider.cjs");
  writeFileSync(fixture, script);
  const store = new Store(join(root, "db.sqlite"));
  const project = store.addProject("Test", root, null);
  const session = fixtureSession(store, project.id);
  const runtime = new Runtime(store, root, {
    command: process.execPath,
    prefix: [fixture],
    timeoutMs,
    graceMs: 30,
  });
  const cleanup = async () => {
    await runtime.shutdown();
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, store, session, runtime, cleanup };
}
async function terminal(store: Store, id: string) {
  for (let i = 0; i < 120; i++) {
    const execution = store.detail(id).executions.at(-1);
    if (execution && execution.status !== "running") return execution;
    await delay(20);
  }
  throw new Error("Test execution did not terminate");
}
const successful = `let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
 const emit=x=>console.log(JSON.stringify(x));
 emit({type:'thread.started',thread_id:'test-thread-123'});
 emit({type:'item.completed',item:{id:'a',type:'agent_message',text:prompt}});
 emit({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:3,output_tokens:2}});
});`;

test("actual tool events map without reasoning, arguments or output", () => {
  assert.deepEqual(
    normalizeCodex({
      type: "item.completed",
      item: { id: "r", type: "reasoning", text: "private" },
    }),
    [],
  );
  assert.deepEqual(
    normalizeCodex({
      type: "item.completed",
      item: { id: "a", type: "agent_message", text: '<invoke name="Write">' },
    })[0].type,
    "message.agent",
  );
  const event = normalizeCodex({
    type: "item.completed",
    item: {
      id: "t",
      type: "command_execution",
      status: "failed",
      command: "SECRET",
      aggregated_output: "SECRET",
      exit_code: 1,
    },
  })[0];
  assert.equal(event.type, "tool.completed");
  assert.equal(event.data.exitCode, 1);
  assert.ok(!JSON.stringify(event).includes("SECRET"));
  const usage = normalizeCodex({
    type: "turn.completed",
    usage: { input_tokens: 10 },
  })[0].data;
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.inputTokens, 10);
  assert.equal(
    normalizeCodex({
      type: "item.started",
      item: { id: "m", type: "mcp_tool_call", server: "server", tool: "read" },
    })[0].data.name,
    "server.read",
  );
});

test("continuation args preserve explicit ID and read-only policy", () => {
  const args = codexArgs("test-thread-123", "requested-model");
  assert.deepEqual(args.slice(0, 4), ["-s", "read-only", "-a", "never"]);
  assert.ok(args.indexOf("resume") === args.indexOf("exec") + 1);
  assert.ok(args.includes("test-thread-123"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(!args.includes("--last"));
});

test("successful attempts persist messages, usage, continuation ID and replay", async () => {
  const ctx = setup(successful);
  try {
    ctx.runtime.start(ctx.session.id, "First");
    assert.equal(ctx.store.sessions()[0].latestStatus, "running");
    assert.throws(
      () => ctx.runtime.start(ctx.session.id, "Concurrent"),
      /already running/,
    );
    assert.equal(
      (await terminal(ctx.store, ctx.session.id)).status,
      "completed",
    );
    ctx.runtime.start(ctx.session.id, "Second");
    await terminal(ctx.store, ctx.session.id);
    const detail = ctx.store.detail(ctx.session.id);
    assert.equal(ctx.store.sessions()[0].latestStatus, "completed");
    assert.equal(detail.executions.length, 2);
    assert.equal(detail.session.providerSessionId, "test-thread-123");
    assert.equal(
      detail.events.filter((e) => e.type === "message.agent").length,
      2,
    );
    const cursor = detail.events[2].id;
    assert.ok(
      ctx.store.events(ctx.session.id, cursor).every((e) => e.id > cursor),
    );
    const reopened = new Store(join(ctx.root, "db.sqlite"));
    assert.equal(
      reopened.detail(ctx.session.id).events.length,
      detail.events.length,
    );
    reopened.db.close();
  } finally {
    await ctx.cleanup();
  }
});

test("zero exit without provider success and provider errors cannot complete", async () => {
  for (const script of [
    "process.stdin.resume();",
    "console.log(JSON.stringify({type:'error',message:'secret'}));console.log(JSON.stringify({type:'turn.completed'}));",
  ]) {
    const ctx = setup(script);
    try {
      ctx.runtime.start(ctx.session.id, "go");
      assert.equal(
        (await terminal(ctx.store, ctx.session.id)).status,
        "failed",
      );
      assert.ok(
        !JSON.stringify(ctx.store.events(ctx.session.id)).includes("secret"),
      );
    } finally {
      await ctx.cleanup();
    }
  }
});

test("malformed stream fails with one terminal event", async () => {
  const ctx = setup("console.log('not json');setInterval(()=>{},1000)");
  try {
    ctx.runtime.start(ctx.session.id, "go");
    assert.equal((await terminal(ctx.store, ctx.session.id)).status, "failed");
    assert.equal(
      ctx.store
        .events(ctx.session.id)
        .filter((e) => e.type === "execution.failed").length,
      1,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("cancellation and timeout terminate persistent processes", async () => {
  for (const mode of ["cancel", "timeout"]) {
    const ctx = setup(
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
      mode === "timeout" ? 80 : 2000,
    );
    try {
      ctx.runtime.start(ctx.session.id, "go");
      if (mode === "cancel") {
        await delay(60);
        ctx.runtime.cancel(ctx.session.id);
      }
      assert.equal(
        (await terminal(ctx.store, ctx.session.id)).status,
        mode === "cancel" ? "cancelled" : "timed_out",
      );
    } finally {
      await ctx.cleanup();
    }
  }
});

test("startup recovery marks orphan attempts interrupted without replaying", async () => {
  const ctx = setup(successful);
  try {
    ctx.store.begin(ctx.session, null, "pending");
    ctx.store.recover();
    ctx.store.recover();
    assert.equal(
      ctx.store.detail(ctx.session.id).executions[0].status,
      "interrupted",
    );
    assert.equal(
      ctx.store
        .events(ctx.session.id)
        .filter((e) => e.type === "execution.interrupted").length,
      1,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("workspace confinement resolves symlinks and rejects outside directories", async () => {
  const ctx = setup(successful);
  const outside = mkdtempSync(join(tmpdir(), "arbeit-outside-"));
  try {
    assert.equal(workspacePath(ctx.root, ctx.root), ctx.root);
    assert.throws(() => workspacePath(ctx.root, outside), /allowed workspace/);
    symlinkSync(outside, join(ctx.root, "escape"));
    assert.throws(
      () => workspacePath(ctx.root, join(ctx.root, "escape")),
      /allowed workspace/,
    );
  } finally {
    await ctx.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("origin checks reject DNS rebinding, cross-site reads and missing mutation origin", () => {
  assert.throws(() =>
    checkOrigin({ method: "GET", headers: { host: "evil.test:3000" } }, 3000),
  );
  assert.throws(() =>
    checkOrigin(
      {
        method: "GET",
        headers: { host: "localhost:3000", origin: "https://evil.test" },
      },
      3000,
    ),
  );
  assert.throws(() =>
    checkOrigin(
      {
        method: "GET",
        headers: { host: "localhost:3000", "sec-fetch-site": "cross-site" },
      },
      3000,
    ),
  );
  assert.throws(() =>
    checkOrigin({ method: "POST", headers: { host: "localhost:3000" } }, 3000),
  );
  assert.doesNotThrow(() =>
    checkOrigin(
      {
        method: "POST",
        headers: { host: "localhost:3000", origin: "http://localhost:3000" },
      },
      3000,
    ),
  );
});

test("HTTP SSE replays scoped events; disconnect does not cancel execution", async () => {
  const ctx = setup(
    "let x='';process.stdin.on('data',d=>x+=d);process.stdin.on('end',()=>setTimeout(()=>{console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}))},200));",
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  server.on("request", getRequestListener(api(ctx.runtime, port).fetch));
  const base = `http://127.0.0.1:${port}`;
  try {
    const forbidden = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.test",
      },
      body: "{}",
    });
    assert.equal(forbidden.status, 403);
    ctx.runtime.start(ctx.session.id, "disconnect");
    const controller = new AbortController();
    const response = await fetch(
      `${base}/api/sessions/${ctx.session.id}/events?after=0`,
      { signal: controller.signal },
    );
    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.ok(chunk.includes("message.user"));
    controller.abort();
    assert.equal(
      (await terminal(ctx.store, ctx.session.id)).status,
      "completed",
    );
    const other = fixtureSession(ctx.store, ctx.session.projectId);
    assert.equal(ctx.store.events(other.id).length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.cleanup();
  }
});

test("cancellation kills descendants even if the provider exits first", async () => {
  if (process.platform === "win32") return;
  const ctx =
    setup(`const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
fs.writeFileSync('descendant.pid',String(child.pid));process.stdin.resume();setInterval(()=>{},1000);`);
  let descendant: number | undefined;
  try {
    ctx.runtime.start(ctx.session.id, "cancel process tree");
    for (let i = 0; i < 50; i++) {
      try {
        descendant = Number(
          (await import("node:fs")).readFileSync(
            join(ctx.root, "descendant.pid"),
            "utf8",
          ),
        );
        break;
      } catch {
        await delay(10);
      }
    }
    assert.ok(descendant);
    await delay(60);
    ctx.runtime.cancel(ctx.session.id);
    assert.equal(
      (await terminal(ctx.store, ctx.session.id)).status,
      "cancelled",
    );
    await delay(50);
    assert.throws(
      () => process.kill(descendant!, 0),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
    );
  } finally {
    if (descendant) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        /* The descendant has already exited. */
      }
    }
    await ctx.cleanup();
  }
});

test("missing executable fails durably instead of leaving an active attempt", async () => {
  const ctx = setup(successful);
  try {
    const runtime = new Runtime(ctx.store, ctx.root, {
      command: join(ctx.root, "missing-cli"),
    });
    runtime.start(ctx.session.id, "start");
    const result = await terminal(ctx.store, ctx.session.id);
    assert.equal(result.status, "failed");
    assert.match(
      String(ctx.store.events(ctx.session.id).at(-1)?.data.message),
      /could not start/,
    );
    await runtime.shutdown();
  } finally {
    await ctx.cleanup();
  }
});

test("oversized JSONL streams terminate rather than growing memory indefinitely", async () => {
  const ctx = setup(
    "process.stdout.write('x'.repeat(1100000));setInterval(()=>{},1000)",
  );
  try {
    ctx.runtime.start(ctx.session.id, "go");
    assert.equal((await terminal(ctx.store, ctx.session.id)).status, "failed");
  } finally {
    await ctx.cleanup();
  }
});

test("draft sessions stay transient; first execution persists session, attempt and events together", async () => {
  const ctx = setup(successful);
  try {
    const before = ctx.store.sessions().length;
    ctx.store.draftSession(ctx.session.projectId);
    ctx.store.draftSession(ctx.session.projectId);
    assert.equal(ctx.store.sessions().length, before);
    assert.throws(
      () => ctx.runtime.startNew(ctx.session.projectId, "   "),
      /Invalid objective/,
    );
    assert.equal(ctx.store.sessions().length, before);
    const result = ctx.runtime.startNew(
      ctx.session.projectId,
      "Inspect the build configuration",
    );
    assert.equal(ctx.store.sessions().length, before + 1);
    const detail = ctx.store.detail(result.session.id);
    assert.equal(detail.session.title, "Inspect the build configuration");
    assert.equal(detail.executions[0].id, result.executionId);
    assert.equal(detail.executions[0].status, "running");
    assert.deepEqual(
      detail.events.map((e) => e.type),
      ["message.user", "execution.started"],
    );
    await terminal(ctx.store, result.session.id);
    ctx.runtime.start(result.session.id, "Continue");
    await terminal(ctx.store, result.session.id);
    assert.equal(ctx.store.sessions().length, before + 1);
  } finally {
    await ctx.cleanup();
  }
});

test("failed first-execution transaction leaves no empty session or partial attempt", async () => {
  const ctx = setup(successful);
  try {
    const before = ctx.store.sessions().length;
    ctx.store.db.exec(
      "CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event failure'); END;",
    );
    assert.throws(
      () => ctx.runtime.startNew(ctx.session.projectId, "Inspect"),
      /event failure/,
    );
    assert.equal(ctx.store.sessions().length, before);
    assert.equal(
      ctx.store.db.prepare("SELECT count(*) AS count FROM executions").get()
        ?.count,
      0,
    );
    assert.equal(
      ctx.store.db.prepare("SELECT count(*) AS count FROM events").get()?.count,
      0,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("Hono validates execution commands and does not persist invalid drafts", async () => {
  const ctx = setup(successful);
  try {
    const app = api(ctx.runtime, 3000);
    const headers = {
      Host: "localhost:3000",
      Origin: "http://localhost:3000",
      "Content-Type": "application/json",
    };
    const before = ctx.store.sessions().length;
    for (const payload of [
      { projectId: ctx.session.projectId },
      { projectId: ctx.session.projectId, text: " " },
      { projectId: "missing", text: "Inspect" },
    ]) {
      const response = await app.request("http://localhost:3000/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.ok([400, 404].includes(response.status));
      assert.equal(ctx.store.sessions().length, before);
    }
    const oversized = await app.request("http://localhost:3000/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "x".repeat(41000) }),
    });
    assert.equal(oversized.status, 413);
    const created = await app.request("http://localhost:3000/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: ctx.session.projectId,
        text: "Inspect",
      }),
    });
    assert.equal(created.status, 202);
    const value = await created.json();
    await terminal(ctx.store, value.session.id);
    assert.equal(ctx.store.sessions().length, before + 1);
    const invalidCursor = await app.request(
      `http://localhost:3000/api/sessions/${value.session.id}/events?after=-1`,
      { headers },
    );
    assert.equal(invalidCursor.status, 400);
    const wrongHost = await app.request("http://localhost:3000/api/bootstrap", {
      headers: { Host: "evil.test:3000" },
    });
    assert.equal(wrongHost.status, 403);
    const noOrigin = await app.request("http://localhost:3000/api/sessions", {
      method: "POST",
      headers: { Host: "localhost:3000", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(noOrigin.status, 403);
  } finally {
    await ctx.cleanup();
  }
});
