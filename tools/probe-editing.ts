// Explicit live-provider validation. Not run by the automated test suite.
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/lib/store";
import { Runtime } from "../src/lib/runtime";

const root = realpathSync(process.cwd());
const repo = resolve(root, "tmp/editing-validation/repo");
mkdirSync(repo, { recursive: true });
writeFileSync(resolve(repo, "greeting.txt"), "todo\n");
writeFileSync(
  resolve(repo, "package.json"),
  JSON.stringify(
    {
      name: "arbeit-editing-validation",
      private: true,
      scripts: { test: "node --test" },
    },
    null,
    2,
  ),
);
writeFileSync(
  resolve(repo, "greeting.test.cjs"),
  "const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('greeting is ready',()=>assert.equal(fs.readFileSync('greeting.txt','utf8'),'ready\\n'));\n",
);
writeFileSync(
  resolve(repo, "AGENTS.md"),
  "This is an isolated validation fixture. Only change greeting.txt as requested. Run npm test separately. Do not modify the test or package.json, commit, push, or access credentials. Trello development tracking is handled by the parent Arbeit implementation task.\n",
);
for (const args of [
  ["init", "-q"],
  ["add", "."],
  [
    "-c",
    "user.name=Arbeit validation",
    "-c",
    "user.email=validation@example.invalid",
    "commit",
    "-qm",
    "Validation fixture",
  ],
])
  execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
const store = new Store(resolve(root, ".arbeit/arbeit.sqlite"));
const project =
  store.projects().find((item) => item.path === repo) ??
  store.addProject("Editing validation", repo, null);
store.settings(project.id, "workspace-write", ["test"], null);
const runtime = new Runtime(store, root, {
  worktreeRoot: resolve(root, ".arbeit/worktrees"),
});
const result = runtime.startNew(
  project.id,
  "Change greeting.txt from todo to ready, preserving the trailing newline. Do not modify any other file. Run npm test as a separate command and return the structured outcome.",
  "https://trello.com/c/udIj5awj",
);
console.log(JSON.stringify({ sessionId: result.session.id, phase: "started" }));
let status = "running";
while (status === "running") {
  await delay(500);
  status = store.detail(result.session.id).executions[0].status;
}
const detail = store.detail(result.session.id);
const execution = detail.executions[0];
const evidence = {
  sessionId: result.session.id,
  executionId: execution.id,
  status: execution.status,
  review: execution.review,
  sourceUnchanged:
    readFileSync(resolve(repo, "greeting.txt"), "utf8") === "todo\n",
  events: detail.events.filter((event) =>
    [
      "tool.started",
      "tool.completed",
      "check.completed",
      "usage",
      "execution.completed",
      "execution.failed",
    ].includes(event.type),
  ),
};
mkdirSync(resolve(root, "tmp/evidence"), { recursive: true });
writeFileSync(
  resolve(root, "tmp/evidence/editing-live.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(
  JSON.stringify({
    sessionId: result.session.id,
    status: execution.status,
    outcome: execution.review?.outcome,
    checks: execution.review?.checks,
    sourceUnchanged: evidence.sourceUnchanged,
  }),
);
await runtime.shutdown();
store.db.close();
if (
  execution.status !== "completed" ||
  execution.review?.outcome !== "ready_for_review" ||
  !evidence.sourceUnchanged
)
  process.exitCode = 1;
