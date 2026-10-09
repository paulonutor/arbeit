import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/lib/store";
import { Runtime } from "../src/lib/runtime";
import { Dispatcher } from "../src/lib/dispatcher";
import { Trello, taskObjective, type TaskSource } from "../src/lib/trello";
import { checkCommand, providerEnvironment } from "../src/lib/workspace";
import { api } from "../src/lib/http";
import type { TrelloCard, WorkflowConfig } from "../src/lib/types";

const ids = {
  board: "1".repeat(24),
  ready: "2".repeat(24),
  running: "3".repeat(24),
  review: "4".repeat(24),
  label: "5".repeat(24),
};
const config: WorkflowConfig = {
  boardId: ids.board,
  readyListId: ids.ready,
  runningListId: ids.running,
  reviewListId: ids.review,
  labelId: ids.label,
  enabled: false,
  remaining: 0,
  reason: null,
};
function card(id = "6".repeat(24), pos = 1): TrelloCard {
  return {
    id,
    pos,
    name: "Implement greeting",
    desc: "Change greeting.txt to ready and verify it.",
    url: `https://trello.com/c/${id}`,
    idBoard: ids.board,
    idList: ids.ready,
    idLabels: [ids.label],
    closed: false,
    checklists: [
      {
        name: "Acceptance",
        checkItems: [{ name: "Greeting is ready", state: "incomplete" }],
      },
    ],
  };
}
class Source implements TaskSource {
  configured = true;
  entries = [card()];
  reports: string[] = [];
  moves: string[] = [];
  failMove = false;
  async board() {
    return { id: ids.board, name: "Test" };
  }
  async lists() {
    return [
      { id: ids.ready, name: "Ready" },
      { id: ids.running, name: "Running" },
      { id: ids.review, name: "Review" },
    ];
  }
  async labels() {
    return [{ id: ids.label, name: "Explicitly ready" }];
  }
  async cards(listId = ids.ready) {
    return this.entries.filter((entry) => entry.idList === listId);
  }
  async card(id: string) {
    return this.entries.find((entry) => entry.id === id)!;
  }
  async move(id: string, listId: string) {
    if (this.failMove) throw new Error("unknown external result");
    this.entries.find((entry) => entry.id === id)!.idList = listId;
    this.moves.push(listId);
  }
  async report(_id: string, receiptId: string, text: string) {
    if (!this.reports.some((value) => value.startsWith(receiptId)))
      this.reports.push(`${receiptId}\n${text}`);
  }
}
const successful = `process.stdin.resume();process.stdin.on('end',()=>{
const fs=require('node:fs');fs.writeFileSync('greeting.txt','ready\\n');
const emit=x=>console.log(JSON.stringify(x));
emit({type:'thread.started',thread_id:'workflow-thread'});
emit({type:'item.completed',item:{id:'check',type:'command_execution',command:"/bin/zsh -lc 'npm test'",status:'completed',exit_code:0}});
emit({type:'item.completed',item:{id:'final',type:'agent_message',text:JSON.stringify({outcome:'ready_for_review',summary:'Greeting implemented and checked.',question:null})}});
emit({type:'turn.completed',usage:{input_tokens:10,output_tokens:4}});
});`;
function setup(script = successful) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arbeit-workflow-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "greeting.txt"), "todo\n");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Arbeit fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Fixture",
    ],
  ])
    execFileSync("git", args, { cwd: repo });
  const provider = join(root, "provider.cjs");
  writeFileSync(provider, script);
  const store = new Store(join(root, "state.sqlite"));
  const project = store.addProject("Fixture", repo, null);
  store.settings(project.id, "workspace-write", ["test"], config);
  const runtime = new Runtime(store, root, {
    command: process.execPath,
    prefix: [provider],
    worktreeRoot: join(root, "worktrees"),
    timeoutMs: 2000,
    graceMs: 30,
  });
  const source = new Source();
  const dispatcher = new Dispatcher(runtime, source, 0);
  const cleanup = async () => {
    await dispatcher.stop();
    await runtime.shutdown();
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, repo, store, project, runtime, source, dispatcher, cleanup };
}
async function finish(ctx: ReturnType<typeof setup>, id: string) {
  for (let i = 0; i < 150; i++) {
    const execution = ctx.store.detail(id).executions.at(-1);
    if (execution && execution.status !== "running") return execution;
    await delay(20);
  }
  throw new Error("Fixture execution did not finish.");
}

test("isolated editing captures actual diff and observed checks without changing source checkout", async () => {
  const ctx = setup();
  try {
    const result = ctx.runtime.startNew(ctx.project.id, "Implement greeting");
    const execution = await finish(ctx, result.session.id);
    assert.equal(execution.status, "completed");
    assert.equal(execution.review?.outcome, "ready_for_review");
    assert.equal(execution.review?.checks[0].status, "passed");
    assert.deepEqual(execution.review?.files, ["greeting.txt"]);
    assert.match(execution.review!.diff, /\+ready/);
    assert.equal(
      readFileSync(join(ctx.repo, "greeting.txt"), "utf8"),
      "todo\n",
    );
    assert.equal(
      readFileSync(join(result.session.workspace!, "greeting.txt"), "utf8"),
      "ready\n",
    );
    ctx.runtime.start(result.session.id, "Continue");
    await finish(ctx, result.session.id);
    assert.equal(
      ctx.store.detail(result.session.id).session.workspace,
      result.session.workspace,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("dirty sources and revoked permission reject editing without persisting a session", async () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.repo, "greeting.txt"), "local change\n");
    assert.throws(
      () => ctx.runtime.startNew(ctx.project.id, "go"),
      /Commit or stash/,
    );
    assert.equal(ctx.store.sessions().length, 0);
    writeFileSync(join(ctx.repo, "greeting.txt"), "todo\n");
    const result = ctx.runtime.startNew(ctx.project.id, "go");
    await finish(ctx, result.session.id);
    ctx.store.settings(ctx.project.id, "read-only", [], config);
    assert.throws(
      () => ctx.runtime.start(result.session.id, "Continue"),
      /revoked/,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("structured questions pause the task; arbitrary assistant prose is not a permission request", async () => {
  const script = successful
    .replace("'ready_for_review'", "'needs_input'")
    .replace("question:null", "question:'Which greeting should be used?'");
  const ctx = setup(script);
  try {
    await ctx.dispatcher.arm(ctx.project.id, 1);
    await ctx.dispatcher.tick();
    const receipt = ctx.store.receipts()[0];
    await finish(ctx, receipt.sessionId!);
    await ctx.dispatcher.tick();
    assert.equal(ctx.store.project(ctx.project.id).workflow?.enabled, false);
    assert.equal(ctx.store.receipts()[0].status, "paused");
    assert.equal(
      ctx.store.detail(receipt.sessionId!).executions[0].review?.outcome,
      "needs_input",
    );
    assert.equal(
      ctx.store
        .events(receipt.sessionId!)
        .filter((event) => event.type === "interaction.requested").length,
      1,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("agent success without observed required checks cannot become ready for review", async () => {
  const ctx = setup(
    successful.replace(
      "command:\"/bin/zsh -lc 'npm test'\"",
      "command:'npm test; true'",
    ),
  );
  try {
    const result = ctx.runtime.startNew(ctx.project.id, "go");
    const execution = await finish(ctx, result.session.id);
    assert.equal(execution.review?.checks[0].status, "not_run");
    assert.equal(execution.review?.outcome, "blocked");
  } finally {
    await ctx.cleanup();
  }
});

test("sequential automatic batch claims only explicitly eligible cards and reports review results", async () => {
  const ctx = setup();
  try {
    ctx.source.entries.push(
      { ...card("7".repeat(24), 2), idLabels: [] },
      card("8".repeat(24), 3),
    );
    await ctx.dispatcher.arm(ctx.project.id, 2);
    await Promise.all([ctx.dispatcher.tick(), ctx.dispatcher.tick()]);
    assert.equal(ctx.store.sessions().length, 1);
    const first = ctx.store.receipts()[0];
    await finish(ctx, first.sessionId!);
    await ctx.dispatcher.tick();
    assert.equal(ctx.store.sessions().length, 2);
    const second = ctx.store
      .receipts()
      .find((receipt) => receipt.id !== first.id)!;
    await finish(ctx, second.sessionId!);
    await ctx.dispatcher.tick();
    await ctx.dispatcher.tick();
    assert.equal(
      ctx.store.receipts().filter((receipt) => receipt.status === "reported")
        .length,
      2,
    );
    assert.equal(ctx.source.reports.length, 2);
    assert.ok(ctx.source.reports[0].includes("test: passed"));
    assert.equal(
      ctx.source.entries.find((entry) => entry.id === "7".repeat(24))!.idList,
      ids.ready,
    );
    assert.equal(ctx.store.project(ctx.project.id).workflow?.enabled, false);
    assert.equal(ctx.store.sessions().length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test("uncertain Trello claim pauses and will not execute or retry automatically", async () => {
  const ctx = setup();
  try {
    ctx.source.failMove = true;
    await ctx.dispatcher.arm(ctx.project.id, 1);
    await ctx.dispatcher.tick();
    assert.equal(ctx.store.sessions().length, 0);
    assert.equal(ctx.store.receipts()[0].status, "paused");
    assert.equal(ctx.store.project(ctx.project.id).workflow?.enabled, false);
    ctx.source.failMove = false;
    await ctx.dispatcher.tick();
    assert.equal(ctx.store.sessions().length, 0);
    await assert.rejects(ctx.dispatcher.arm(ctx.project.id, 1), /Resolve/);
    ctx.dispatcher.acknowledge(ctx.project.id, ctx.store.receipts()[0].id);
    await ctx.dispatcher.arm(ctx.project.id, 1);
    await ctx.dispatcher.tick();
    assert.equal(ctx.store.sessions().length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("pausing during a pending Trello read prevents automatic execution", async () => {
  const ctx = setup();
  try {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.source.cards = async () => {
      await pending;
      return ctx.source.entries;
    };
    await ctx.dispatcher.arm(ctx.project.id, 1);
    const tick = ctx.dispatcher.tick();
    ctx.dispatcher.pause(ctx.project.id);
    release();
    await tick;
    assert.equal(ctx.store.sessions().length, 0);
    assert.equal(ctx.store.receipts().length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("restart pauses dispatch and marks in-flight claims non-replayable", async () => {
  const ctx = setup("process.stdin.resume();setInterval(()=>{},1000)");
  try {
    await ctx.dispatcher.arm(ctx.project.id, 1);
    await ctx.dispatcher.tick();
    const receipt = ctx.store.receipts()[0];
    await ctx.runtime.shutdown();
    ctx.store.workflow(ctx.project.id, {
      ...config,
      enabled: true,
      remaining: 1,
    });
    const runtime = new Runtime(ctx.store, ctx.root);
    const dispatcher = new Dispatcher(runtime, ctx.source, 0);
    assert.equal(ctx.store.project(ctx.project.id).workflow?.enabled, false);
    assert.equal(ctx.store.receipts()[0].status, "paused");
    await dispatcher.tick();
    assert.equal(ctx.store.sessions().length, 1);
    assert.equal(
      ctx.store.detail(receipt.sessionId!).executions[0].status,
      "cancelled",
    );
    await dispatcher.stop();
    await runtime.shutdown();
  } finally {
    await ctx.cleanup();
  }
});

test("Trello REST uses secret headers, fixed origin, bounded errors and idempotent reporting", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify([
        { data: { text: "Arbeit receipt receipt-1\nreported" } },
      ]),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const source = new Trello("privatekey", "privatetoken", fake);
  await source.report("6".repeat(24), "receipt-1", "result");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://api.trello.com/1/"));
  assert.ok(!calls[0].url.includes("private"));
  assert.ok(
    String(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).includes("privatetoken"),
  );
  const denied = new Trello(
    "privatekey",
    "privatetoken",
    async () => new Response("privatetoken", { status: 429 }),
  );
  await assert.rejects(denied.cards(ids.ready), /rate limit/);
  assert.equal(checkCommand("npm test && true", ["test"]), null);
  assert.equal(checkCommand("/bin/zsh -lc 'npm test'", ["test"]), "test");
  const prior = process.env.ARBEIT_TRELLO_TOKEN;
  process.env.ARBEIT_TRELLO_TOKEN = "secret";
  assert.equal(providerEnvironment().ARBEIT_TRELLO_TOKEN, undefined);
  if (prior === undefined) delete process.env.ARBEIT_TRELLO_TOKEN;
  else process.env.ARBEIT_TRELLO_TOKEN = prior;
});

test("workflow API preserves origin guards and validates project configuration", async () => {
  const ctx = setup();
  try {
    const app = api(ctx.runtime, 3000, ctx.dispatcher);
    const headers = {
      Host: "localhost:3000",
      Origin: "http://localhost:3000",
      "Content-Type": "application/json",
    };
    const invalid = await app.request(
      `http://localhost:3000/api/projects/${ctx.project.id}/workflow`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ...config, reviewListId: ids.ready }),
      },
    );
    assert.equal(invalid.status, 400);
    const invalidCheck = await app.request(
      `http://localhost:3000/api/projects/${ctx.project.id}/settings`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          mode: "workspace-write",
          checks: ["exec arbitrary"],
        }),
      },
    );
    assert.equal(invalidCheck.status, 400);
    const arm = await app.request(
      `http://localhost:3000/api/projects/${ctx.project.id}/dispatch`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "arm", limit: 1 }),
      },
    );
    assert.equal(arm.status, 200);
    const hostile = await app.request(
      `http://localhost:3000/api/projects/${ctx.project.id}/dispatch`,
      {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.test" },
        body: "{}",
      },
    );
    assert.equal(hostile.status, 403);
    assert.match(taskObjective(card()), /Greeting is ready/);
  } finally {
    await ctx.cleanup();
  }
});

test("Kanban reads all Trello lists without claiming cards and exposes missing connection", async () => {
  const ctx = setup();
  try {
    const running = {
      ...card("7".repeat(24)),
      idList: ids.running,
      idLabels: [],
    };
    const archived = { ...card("8".repeat(24)), closed: true };
    const foreign = { ...card("9".repeat(24)), idBoard: "a".repeat(24) };
    ctx.source.entries.push(running, archived, foreign);
    const app = api(ctx.runtime, 3000, ctx.dispatcher);
    const response = await app.request(
      `http://localhost:3000/api/projects/${ctx.project.id}/board`,
      { headers: { Host: "localhost:3000" } },
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.configured, true);
    assert.deepEqual(
      data.lists.map((list: { name: string; cards: TrelloCard[] }) => [
        list.name,
        list.cards.map((card) => card.id),
      ]),
      [
        ["Ready", [card().id]],
        ["Running", [running.id]],
        ["Review", []],
      ],
    );
    assert.equal(ctx.store.receipts(ctx.project.id).length, 0);
    assert.equal(ctx.source.moves.length, 0);
    ctx.source.configured = false;
    const unavailable = await app.request(
      `http://localhost:3000/api/projects/${ctx.project.id}/board`,
      { headers: { Host: "localhost:3000" } },
    );
    assert.deepEqual(await unavailable.json(), {
      configured: false,
      board: null,
      lists: [],
    });
  } finally {
    await ctx.cleanup();
  }
});
