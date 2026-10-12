# Architecture

## Decision

Use Hono on one long-lived Node.js server, with a React/Vite frontend. The user selected Hono in place of the initial Next.js stack. The server owns child processes and SQLite connections; React owns presentation only. Browser disconnects and Vite frontend reloads do not stop execution. Restarting the server ends active attempts; persisted history remains. A separate worker is unnecessary for this localhost slice and can be introduced if runtime deployment requires it.

Hono routes HTTP commands and replayable SSE; Vite supplies frontend development middleware and production assets. Both share the localhost origin in one server. Use TypeScript, React, Tailwind and shadcn/ui components. Use Node 24's built-in SQLite API to avoid an additional database service or native addon. SSE delivers committed events and supports replay through a monotonically increasing database sequence. SQLite is the durable source of conversation history; Trello remains the source of development tasks.

## Product direction

Arbeit is an automatic development system. Sessions hold the objective, provider continuation and execution history; their UI is an observation and intervention surface. The runtime must remain callable independently of the UI so later scheduling, task selection and deterministic dependency/retry handling can invoke it. A bounded dispatcher polls configured Trello lists and runs explicitly labelled cards sequentially. Trello remains the external source of task truth. Do not add a separate local task backlog or infer tasks from tool activity.

## Provider boundary

The first adapter uses Codex exec --json, with an explicit provider ID for continuation. Spawn an argument array, pass the prompt through stdin and close it, and set a canonical registered project path as cwd. Use --ignore-user-config to avoid implicitly loading user hooks/MCP configuration in this initial integration; authentication still uses the existing Codex login. Default to read-only. An explicit project policy permits workspace-write in a new isolated Git worktree with required checks, network disabled and approval policy never. Never bypass provider permissions. Native Codex configuration is therefore only partially preserved in this slice.

The Claude adapter (src/lib/claude.ts) uses `claude -p --output-format stream-json --verbose` with the prompt on stdin, explicit `--resume` IDs, `--strict-mcp-config`, `--setting-sources ''`, `--disable-slash-commands` and `--permission-mode dontAsk`. Tools are limited with `--tools` and `--allowedTools`; editing allows Bash only for the project's exact required checks. The final decision uses `--json-schema` and arrives as result `structured_output`. Both providers sit behind the adapter interface in src/lib/providers.ts (arguments, a stateful event parser and a contract source); the runtime holds no provider-specific event logic. The provider is a project setting copied onto each session at creation.

src/lib/setup.ts handles download and authentication. It resolves binaries from PATH, then `.arbeit/providers/node_modules/.bin`; probes `--version` and the provider's status command (`claude auth status`, `codex login status`); installs the fixed official npm package with `npm install --prefix`; and runs the provider's own login as a cancellable job, surfacing only an https sign-in URL on an allow-listed provider host. When the CLI prints its `Paste code here` prompt the job reports `awaitingCode`, and a validated code can be written once to the CLI's stdin (Claude's redirect page shows the code, so no localhost callback is needed). Jobs are in memory. Output is bounded, never persisted, and only a one-line failure reason is exposed. A restart forgets jobs; status is always re-probed.

Normalize only observed message, tool, error and usage events. Do not store reasoning or whole raw lines. Do not infer model identity from configuration. The requested model can be shown separately from a reported model. MCP and file-change mappings follow documented item fields and require tests before broader claims.

The Claude provider remains researched, not implemented in the first slice. Its streaming chunks, tool blocks and cumulative usage need different normalization. Native permission hosts and app-server interactivity are separate future integrations, not interchangeable exec flags.

## Lifecycle

Project registration resolves a real directory inside ARBEIT_WORKSPACE_ROOT. One active execution per logical session. A new session is an in-memory browser draft. The first Run command validates its objective and canonical project path, then commits the session, first execution and initial events in one transaction before spawning a process. Invalid commands and failed transactions leave no empty session. Subsequent instructions create attempts under the same session. Failed provider startup still records a failed attempt, because execution was requested. Each normalized event commits before SSE delivery. A successful terminal provider event and zero process exit are required for completion. Cancellation sends SIGTERM to the process group, escalates to SIGKILL after a grace period, and records cancelled only after process exit. A timeout records timed_out. Startup marks previously active attempts interrupted; users choose whether to continue. The application does not auto-retry uncertain side effects.

A stalled or malformed stream fails closed with bounded line/output sizes. Unknown event types are ignored; provider errors are visible. Stderr is not persisted, since it may contain account data. Execution errors use stable application messages. Tool outputs can contain user data and secrets: retained tool summaries omit output and arguments by default, retaining type/name/status/exit code.

## Local security

Bind HTTP to 127.0.0.1. Accept only localhost or 127.0.0.1 Host headers at the configured port. Reject cross-site requests and require an exact same-origin Origin on mutations. No CORS. Reject oversized JSON bodies, invalid IDs and arbitrary request paths. Canonicalize registered workspace paths and revalidate before each spawn to catch changed symlinks. CLI execution uses shell:false. The prompt never becomes a shell command.

Local execution trusts the chosen workspace and the installed provider. The selected provider sandbox is the execution boundary; localhost is not an authorization boundary against other local processes. Remote hosting, Docker execution and artifact serving are outside this slice. Do not bind publicly without authentication and authorization.

## Domain model

| Entity        | Initial fields and role                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| Project       | ID, name, canonical path, requested model; registered allowed directory         |
| Session       | ID, project ID, title, provider, provider session ID, created time              |
| Execution     | ID, session ID, requested model, status, start/end times, process exit code     |
| AgentEvent    | Global sequence ID, session/execution IDs, type, timestamp, normalized JSON     |
| Usage         | An event with nullable token counts and explicit scope; attempt-local for Codex |
| TaskReference | Trello card URL stored only when needed; no local task entity/backlog           |

Provider capabilities are adapter metadata. Project policy, session worktree/base commit, execution review and durable task_receipts now support controlled editing and dispatch. Separate Artifact and Worker tables remain deferred. This avoids speculative tables while preserving the session/attempt distinction.

## Tradeoffs

Vite produces static frontend assets; `npm start` runs Hono and the agent runtime with Node/tsx and serves those assets. This is a long-lived local application, not a stateless serverless function. Frontend development reloads do not reload runtime state. Backend edits require a server restart. SQLite synchronous operations are short, and one process owns writes. Horizontal execution and Docker packaging are deferred.

SSE carries final Codex message items as they arrive, not fabricated token deltas. Quotas and exact context occupancy display unavailable because this adapter does not integrate app-server. Conversation contents are persisted locally in .arbeit; never commit that directory.

## Editing and dispatch

A new editing session requires a clean committed Git source and creates its own branch/worktree. Its mode, baseline and workspace are retained for continuation. Source edits are never applied automatically. The result schema requires outcome, summary and nullable question; only that explicit contract creates a decision request. Review combines the contract with actual Git differences and observed successful check commands. Missing checks or missing contracts prevent review-ready status.

The dispatcher reads cards directly from Trello. Eligibility requires the selected board, ready list, label and open status. SQLite receipts uniquely claim card IDs before external writes. Claim/report failures pause the project rather than retrying uncertain side effects. Reporting uses receipt/attempt markers to avoid duplicate comments on explicit retries. Restarts pause dispatch and retain unresolved receipts. Only one editing execution runs globally; batches are bounded to ten tasks. Pause is rechecked after asynchronous reads and claims. Changing a workflow requires resolving existing receipts.

The server uses Trello key/token headers against a fixed API origin; provider child environments omit ARBEIT_* values. This is environment separation, not protection against a trusted provider reading local files. Trello credentials and ignored source files are not copied into worktrees. Each task starts from source HEAD, so dependency ordering alone does not incorporate an earlier task's unmerged changes.
