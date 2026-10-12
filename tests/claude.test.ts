import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Store } from "../src/lib/store";
import { Runtime } from "../src/lib/runtime";
import { api } from "../src/lib/http";
import { claudeArgs, createClaudeParser } from "../src/lib/claude";
import { resolveBinary } from "../src/lib/providers";
import { ProviderSetup, loginUrl } from "../src/lib/setup";
import type { WorkflowConfig } from "../src/lib/types";

const init = {
  type: "system",
  subtype: "init",
  session_id: "0502df12-fcb5-5c8b-89fb-e4a786b00411",
  model: "claude-sonnet-5-5",
  tools: ["Read"],
};
const toolUse = (id: string, name: string, input: object) => ({
  type: "assistant",
  message: {
    id: "msg_1",
    model: "claude-sonnet-5-5",
    content: [{ type: "tool_use", id, name, input }],
  },
});
const toolResult = (id: string, is_error = false) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: id, content: "SECRET", is_error },
    ],
  },
});

test("Claude events map to actual messages, tools and per-run usage", () => {
  const parse = createClaudeParser();
  const first = parse(init);
  assert.equal(first.providerSessionId, init.session_id);
  assert.deepEqual(first.events, [
    { type: "model.reported", data: { model: "claude-sonnet-5-5" } },
  ]);
  assert.deepEqual(parse({ type: "stream_event", event: {} }).events, []);
  const started = parse(toolUse("t1", "Read", { file_path: "/secret" }));
  assert.deepEqual(started.events, [
    {
      type: "tool.started",
      data: {
        providerItemId: "t1",
        kind: "file",
        name: "Read",
        status: "in_progress",
        exitCode: null,
      },
    },
  ]);
  assert.ok(!JSON.stringify(started).includes("/secret"));
  const done = parse(toolResult("t1"));
  assert.equal(done.events[0].type, "tool.completed");
  assert.equal(done.events[0].data.status, "completed");
  assert.ok(!JSON.stringify(done).includes("SECRET"));
  assert.equal(parse(toolResult("t1")).events.length, 0);
  const failed = createClaudeParser();
  failed(toolUse("t2", "mcp__github__get_issue", {}));
  assert.equal(failed(toolResult("t2", true)).events[0].data.status, "failed");
  assert.equal(
    failed(toolUse("t3", "mcp__github__get_issue", {})).events[0].data.name,
    "github.get_issue",
  );
  const text = parse({
    type: "assistant",
    message: {
      id: "msg_2",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "hello" },
      ],
    },
  });
  assert.deepEqual(text.events, [
    {
      type: "message.agent",
      data: { providerItemId: "msg_2:1", text: "hello" },
    },
  ]);
  const result = parse({
    type: "result",
    subtype: "success",
    is_error: false,
    usage: {
      input_tokens: 4,
      output_tokens: 69,
      cache_read_input_tokens: 72917,
      cache_creation_input_tokens: 3608,
    },
    modelUsage: { "claude-sonnet-5-5": { inputTokens: 999 } },
    total_cost_usd: 1,
  });
  assert.equal(result.succeeded, true);
  assert.deepEqual(result.events[0].data, {
    scope: "execution",
    inputIncludesCached: false,
    inputTokens: 4,
    outputTokens: 69,
    cachedInputTokens: 72917,
    cacheWriteInputTokens: 3608,
    reasoningOutputTokens: null,
  });
  assert.equal(
    parse({ type: "result", subtype: "error_max_turns", is_error: true })
      .failed,
    true,
  );
  assert.equal(
    parse({ type: "result", subtype: "success", is_error: false }).events[0]
      .data.inputTokens,
    null,
  );
});

test("text that looks like a tool call is not activity and the schema tool is hidden", () => {
  const parse = createClaudeParser();
  const out = parse({
    type: "assistant",
    message: {
      id: "m",
      content: [{ type: "text", text: "<tool_use name='Write'>" }],
    },
  });
  assert.deepEqual(
    out.events.map((e) => e.type),
    ["message.agent"],
  );
  const structured = parse(
    toolUse("s", "StructuredOutput", { outcome: "blocked" }),
  );
  assert.deepEqual(structured.events, []);
  assert.deepEqual(structured.structured, { outcome: "blocked" });
});

test("Claude arguments keep permissions on, resume by explicit ID and limit tools", () => {
  const read = claudeArgs("abc-123", "sonnet");
  assert.ok(read.includes("--resume") && read.includes("abc-123"));
  assert.equal(read[read.indexOf("--model") + 1], "sonnet");
  assert.equal(read[read.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(read[read.indexOf("--tools") + 1], "Read,Grep,Glob");
  for (const flag of [
    "--continue",
    "-c",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
  ])
    assert.ok(!read.includes(flag));
  const write = claudeArgs(null, null, "workspace-write", {
    schema: "{}",
    checks: ["test", "lint"],
  });
  assert.equal(
    write[write.indexOf("--allowedTools") + 1],
    "Read,Grep,Glob,Edit,Write,Bash(npm test),Bash(npm run lint)",
  );
  assert.equal(write[write.indexOf("--json-schema") + 1], "{}");
  assert.ok(!write.includes("--resume"));
});

const config: WorkflowConfig = {
  boardId: "1".repeat(24),
  readyListId: "2".repeat(24),
  runningListId: "3".repeat(24),
  reviewListId: "4".repeat(24),
  labelId: "5".repeat(24),
  enabled: false,
  remaining: 0,
  reason: null,
};
function fixture(script: string, mode: "read-only" | "workspace-write") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arbeit-claude-")));
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
      "user.name=f",
      "-c",
      "user.email=f@example.invalid",
      "commit",
      "-qm",
      "x",
    ],
  ])
    execFileSync("git", args, { cwd: repo });
  const provider = join(root, "provider.cjs");
  writeFileSync(provider, script);
  const store = new Store(join(root, "state.sqlite"));
  const project = store.addProject("Fixture", repo, "sonnet", "claude");
  if (mode === "workspace-write")
    store.settings(project.id, mode, ["test"], config);
  const runtime = new Runtime(store, root, {
    command: process.execPath,
    prefix: [provider],
    worktreeRoot: join(root, "worktrees"),
    timeoutMs: 3000,
    graceMs: 30,
  });
  return {
    root,
    store,
    project,
    runtime,
    cleanup: async () => {
      await runtime.shutdown();
      store.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function finish(ctx: ReturnType<typeof fixture>, id: string) {
  for (let i = 0; i < 200; i++) {
    const execution = ctx.store.detail(id).executions.at(-1);
    if (execution && execution.status !== "running") return execution;
    await delay(20);
  }
  throw new Error("Fixture execution did not finish.");
}
const emit = `const emit=x=>console.log(JSON.stringify(x));
const init=${JSON.stringify(init)};`;

test("a Claude session runs, persists the continuation ID and resumes with it", async () => {
  const ctx = fixture(
    `${emit}process.stdin.resume();process.stdin.on('end',()=>{
require('node:fs').appendFileSync('argv.log',JSON.stringify(process.argv.slice(2))+'\\n');
emit(init);
emit({type:'assistant',message:{id:'m1',content:[{type:'text',text:'hi'}]}});
emit({type:'result',subtype:'success',is_error:false,usage:{input_tokens:3,output_tokens:2}});
});`,
    "read-only",
  );
  try {
    const { session } = ctx.runtime.startNew(ctx.project.id, "Hello");
    assert.equal(session.provider, "claude");
    assert.equal((await finish(ctx, session.id)).status, "completed");
    let detail = ctx.store.detail(session.id);
    assert.equal(detail.session.providerSessionId, init.session_id);
    const started = detail.events.find((e) => e.type === "execution.started");
    assert.deepEqual(started?.data, {
      provider: "claude",
      requestedModel: "sonnet",
    });
    assert.equal(
      detail.events.find((e) => e.type === "model.reported")?.data.model,
      "claude-sonnet-5-5",
    );
    ctx.runtime.start(session.id, "Again");
    await finish(ctx, session.id);
    detail = ctx.store.detail(session.id);
    const log = readFileSync(join(ctx.root, "repo", "argv.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(log[0].includes("--model") && !log[0].includes("--resume"));
    assert.equal(log[1][log[1].indexOf("--resume") + 1], init.session_id);
    assert.equal(detail.events.filter((e) => e.type === "usage").length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test("a provider failure result cannot complete a Claude execution", async () => {
  const ctx = fixture(
    `${emit}process.stdin.resume();process.stdin.on('end',()=>{
emit(init);emit({type:'result',subtype:'error_during_execution',is_error:true});});`,
    "read-only",
  );
  try {
    const { session } = ctx.runtime.startNew(ctx.project.id, "Hello");
    assert.equal((await finish(ctx, session.id)).status, "failed");
  } finally {
    await ctx.cleanup();
  }
});

test("Claude editing uses structured output and only observed Bash checks", async () => {
  const script = (
    ran: boolean,
  ) => `${emit}process.stdin.resume();process.stdin.on('end',()=>{
require('node:fs').writeFileSync('greeting.txt','ready\\n');
emit(init);
${
  ran
    ? `emit({type:'assistant',message:{id:'m',content:[{type:'tool_use',id:'b1',name:'Bash',input:{command:'npm test'}}]}});
emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'b1',content:'ok'}]}});`
    : ""
}
emit({type:'assistant',message:{id:'m2',content:[{type:'tool_use',id:'so',name:'StructuredOutput',input:{outcome:'ready_for_review',summary:'Done.',question:null}}]}});
emit({type:'result',subtype:'success',is_error:false,usage:{},structured_output:{outcome:'ready_for_review',summary:'Done.',question:null}});
});`;
  for (const ran of [true, false]) {
    const ctx = fixture(script(ran), "workspace-write");
    try {
      const { session } = ctx.runtime.startNew(ctx.project.id, "Do it");
      const execution = await finish(ctx, session.id);
      assert.equal(execution.status, "completed");
      assert.deepEqual(execution.review?.files, ["greeting.txt"]);
      if (ran) {
        assert.equal(execution.review?.outcome, "ready_for_review");
        assert.equal(execution.review?.checks[0].status, "passed");
      } else {
        // A claimed success without an observed check is downgraded.
        assert.equal(execution.review?.outcome, "blocked");
        assert.equal(execution.review?.checks[0].status, "not_run");
      }
      const events = ctx.store.detail(session.id).events;
      assert.equal(events.filter((e) => e.type === "message.agent").length, 1);
      assert.ok(!events.some((e) => e.data.name === "StructuredOutput"));
    } finally {
      await ctx.cleanup();
    }
  }
});

test("binaries are found without a shell and managed installs are the fallback", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "arbeit-bin-")));
  try {
    assert.equal(resolveBinary("claude", undefined, dir), null);
    const file = join(dir, "claude");
    writeFileSync(file, "#!/bin/sh\n");
    assert.equal(resolveBinary("claude", undefined, dir), null);
    chmodSync(file, 0o755);
    assert.equal(resolveBinary("claude", undefined, dir), file);
    assert.equal(resolveBinary("claude", dir, "/nonexistent"), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only provider sign-in pages are surfaced from CLI output", () => {
  assert.equal(
    loginUrl(
      "Open \u001b[1mhttps://claude.ai/oauth/authorize?code=true&x=1\u001b[0m.",
    ),
    "https://claude.ai/oauth/authorize?code=true&x=1",
  );
  assert.equal(
    loginUrl("visit https://auth.openai.com/codex/device"),
    "https://auth.openai.com/codex/device",
  );
  assert.equal(loginUrl("https://evil.example/claude.ai"), null);
  assert.equal(loginUrl("https://claude.ai.evil.example/x"), null);
  assert.equal(loginUrl("https://user:pw@claude.ai/x"), null);
  assert.equal(loginUrl("http://claude.ai/x"), null);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

function setupFixture(script: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arbeit-setup-")));
  const file = join(root, "tool.cjs");
  writeFileSync(file, script);
  const setup = new ProviderSetup({
    directory: join(root, "providers"),
    timeoutMs: 2000,
    runner: (target, launch) => ({
      command: process.execPath,
      args: [file, target, ...launch.args],
    }),
  });
  return { root, setup };
}
const tool = `const [target,...args]=process.argv.slice(2);
const mode=process.env.TOOL_MODE||'';
if(target==='npm'){console.error('added 1 package');process.exit(mode==='npmfail'?1:0);}
if(args[0]==='--version'){console.log('2.1.296 (Claude Code)');process.exit(0);}
if(args.join(' ')==='auth status'){console.log(JSON.stringify({loggedIn:mode!=='out',authMethod:'oauth_token',configDirectory:'/home/private'}));process.exit(mode==='out'?1:0);}
if(args.join(' ')==='login status'){console.log('Logged in using ChatGPT');process.exit(0);}
if(args.includes('login')){console.log('Open https://claude.ai/oauth/authorize?x=1 to sign in');
if(mode==='code'){process.stdout.write('Paste code here if prompted > ');
process.stdin.once('data',d=>{const ok=d.toString().trim()==='good-code#state-123';console.log(ok?'Login successful':'Invalid code');process.exit(ok?0:1);});}
else setInterval(()=>{},1000);}`;
async function settled(setup: ProviderSetup, id: "claude" | "codex") {
  for (let i = 0; i < 100; i++) {
    const [status] = await setup.status(id);
    if (status.job && status.job.state !== "running") return status;
    await delay(30);
  }
  throw new Error("Job did not settle");
}

test("provider status reports install and sign-in state without leaking CLI details", async () => {
  const ctx = setupFixture(tool);
  try {
    const [codex, claude] = await ctx.setup.status();
    assert.equal(claude.installed, true);
    assert.equal(claude.version, "2.1.296");
    assert.equal(claude.authenticated, true);
    assert.equal(claude.authMethod, "oauth_token");
    assert.ok(!JSON.stringify(claude).includes("/home/private"));
    assert.equal(codex.authMethod, "ChatGPT");
    process.env.TOOL_MODE = "out";
    assert.equal((await ctx.setup.status("claude"))[0].authenticated, false);
  } finally {
    delete process.env.TOOL_MODE;
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("install is a fixed managed npm command with durable failure reporting", async () => {
  const ctx = setupFixture(tool);
  try {
    ctx.setup.install("claude");
    assert.throws(() => ctx.setup.install("claude"), /already running/);
    assert.equal((await settled(ctx.setup, "claude")).job?.state, "succeeded");
    assert.throws(() => ctx.setup.install("codex", true), /active execution/);
    process.env.TOOL_MODE = "npmfail";
    ctx.setup.install("claude");
    const job = (await settled(ctx.setup, "claude")).job;
    assert.equal(job?.state, "failed");
    assert.match(job?.message ?? "", /code 1: added 1 package/);
  } finally {
    delete process.env.TOOL_MODE;
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("sign-in surfaces the provider URL and can be cancelled", async () => {
  const ctx = setupFixture(tool);
  try {
    ctx.setup.login("claude");
    let url: string | null = null;
    for (let i = 0; i < 100 && !url; i++) {
      url = (await ctx.setup.status("claude"))[0].job?.url ?? null;
      await delay(30);
    }
    assert.equal(url, "https://claude.ai/oauth/authorize?x=1");
    ctx.setup.cancel("claude");
    const job = (await ctx.setup.status("claude"))[0].job;
    assert.equal(job?.state, "cancelled");
    assert.equal(job?.url, null);
    assert.throws(() => ctx.setup.cancel("claude"), /Nothing is running/);
  } finally {
    ctx.setup.shutdown();
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("provider API enforces origin, validates ids and actions, and stores the project provider", async () => {
  const ctx = setupFixture(tool);
  const store = new Store(join(ctx.root, "api.sqlite"));
  const runtime = new Runtime(store, ctx.root, {});
  const server = createServer(
    getRequestListener(api(runtime, 3999, undefined, ctx.setup).fetch),
  );
  try {
    const call = (
      path: string,
      method = "GET",
      body?: unknown,
      origin = true,
    ) =>
      new Promise<{ status: number; body: JsonBody }>((resolve, reject) => {
        const address = server.address() as { port: number };
        import("node:http").then(({ request }) => {
          const req = request(
            {
              port: address.port,
              path,
              method,
              headers: {
                host: "127.0.0.1:3999",
                "content-type": "application/json",
                ...(origin ? { origin: "http://127.0.0.1:3999" } : {}),
              },
            },
            (res) => {
              let text = "";
              res.on("data", (c) => (text += c));
              res.on("end", () =>
                resolve({ status: res.statusCode!, body: JSON.parse(text) }),
              );
            },
          );
          req.on("error", reject);
          req.end(body === undefined ? undefined : JSON.stringify(body));
        });
      });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const list = await call("/api/providers");
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.providers.map((p: { id: string }) => p.id),
      ["codex", "claude"],
    );
    assert.equal(
      (await call("/api/providers/bash", "POST", { action: "install" })).status,
      400,
    );
    assert.equal(
      (await call("/api/providers/claude", "POST", { action: "rm" })).status,
      400,
    );
    assert.equal(
      (await call("/api/providers/claude", "POST", { action: "cancel" }, false))
        .status,
      403,
    );
    const post = await call("/api/providers/claude", "POST", {
      action: "install",
    });
    assert.equal(post.status, 202);
    assert.equal(post.body.job.kind, "install");
    await settled(ctx.setup, "claude");
    const project = await call("/api/projects", "POST", {
      name: "P",
      path: ctx.root,
      provider: "claude",
    });
    assert.equal(project.body.provider, "claude");
    assert.equal(
      (
        await call("/api/projects", "POST", {
          name: "Q",
          path: ctx.root,
          provider: "x",
        })
      ).status,
      400,
    );
    const settings = await call(
      `/api/projects/${project.body.id}/settings`,
      "POST",
      {
        mode: "read-only",
        checks: [],
        provider: "codex",
      },
    );
    assert.equal(settings.body.provider, "codex");
  } finally {
    server.close();
    store.db.close();
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("sign-in code is accepted only while the CLI waits, validated, and never exposed", async () => {
  const ctx = setupFixture(tool);
  process.env.TOOL_MODE = "code";
  try {
    assert.throws(
      () => ctx.setup.submitCode("claude", "good-code#state-123"),
      /not waiting/,
    );
    ctx.setup.login("claude");
    for (let i = 0; i < 100; i++) {
      if ((await ctx.setup.status("claude"))[0].job?.awaitingCode) break;
      await delay(30);
    }
    assert.equal((await ctx.setup.status("claude"))[0].job?.awaitingCode, true);
    for (const bad of [
      "",
      "short",
      "has space in it",
      "x".repeat(501),
      42,
      null,
    ])
      assert.throws(
        () => ctx.setup.submitCode("claude", bad),
        /Invalid sign-in code/,
      );
    const job = ctx.setup.submitCode("claude", " good-code#state-123 ");
    assert.equal(job.awaitingCode, false);
    assert.ok(!JSON.stringify(job).includes("good-code"));
    assert.throws(
      () => ctx.setup.submitCode("claude", "good-code#state-123"),
      /not waiting/,
    );
    const done = await settled(ctx.setup, "claude");
    assert.equal(done.job?.state, "succeeded");
    assert.ok(!JSON.stringify(done).includes("good-code"));
    ctx.setup.login("claude");
    for (let i = 0; i < 100; i++) {
      if ((await ctx.setup.status("claude"))[0].job?.awaitingCode) break;
      await delay(30);
    }
    ctx.setup.submitCode("claude", "wrong-code-value");
    const failed = await settled(ctx.setup, "claude");
    assert.equal(failed.job?.state, "failed");
    assert.ok(!JSON.stringify(failed).includes("wrong-code-value"));
  } finally {
    delete process.env.TOOL_MODE;
    ctx.setup.shutdown();
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
