# Provider capabilities

Investigated on 2026-10-09. Installed Codex CLI 0.149.1 and Claude Code 2.1.285. Findings are version-specific. Recheck flags and event schemas before upgrades.

## Evidence levels

- **T**: confirmed by a local command and actual output.
- **D**: official documentation or installed help, not exercised end to end.
- **U**: unavailable in the selected interface.
- **?**: unknown; no reliable evidence.

A positive result on this machine does not establish support for every model, account, operating system or termination point.

| Capability                        | Codex exec                                                       | Claude print                                                            |
| --------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Start session programmatically    | T: thread.started                                                | T: system/init and session_id                                           |
| Continue explicit session         | T: exec resume ID preserved ARBEIT-731                           | T: --resume ID preserved ARBEIT-731                                     |
| Structured event stream           | T: --json JSONL                                                  | T: stream-json + verbose                                                |
| Incremental assistant text        | ?: tested messages arrived complete; app-server documents deltas | T: include-partial-messages text_delta                                  |
| Schema-constrained final response | T: --output-schema                                               | D: --json-schema                                                        |
| Tool invocation                   | T: command_execution item.started                                | T: assistant tool_use Read                                              |
| Tool completion                   | T: item.completed, exit_code and output                          | T: user tool_result linked by tool_use_id                               |
| Tool failure                      | D: failed status/exit code                                       | D: tool_result is_error; not forced locally                             |
| MCP identity and events           | D: mcp_tool_call items                                           | D: MCP server/tool names, tool_use/result                               |
| Shell activity                    | T: actual cat invocation                                         | D: Bash tool; Read exercised instead                                    |
| Browser activity                  | ?: only when installed tools expose events                       | D: optional Chrome/MCP tooling; not enabled/tested                      |
| Token usage                       | T: turn.completed usage                                          | T: result usage and modelUsage                                          |
| Actual model identity             | U in observed exec stream; requested model is separate           | T: init/model and message/model                                         |
| Context capacity                  | U in observed exec stream                                        | T: modelUsage.contextWindow                                             |
| Exact current context consumption | ?: app-server documents tokenUsage updates                       | ?: token usage is not current context occupancy                         |
| Remaining subscription quota      | U in exec stream; T via separate app-server read                 | T: rate_limit_event utilization/reset metadata on this account          |
| Choose/change model per attempt   | D: -m supported on start/resume                                  | D: --model supported; switch not exercised                              |
| Mid-run interactive questions     | U for our bounded exec contract; D via app-server                | D: SDK permission host/MCP handler and streaming input; not implemented |
| Process cancellation              | T: process-group SIGTERM, exit -15                               | D: SIGTERM exit 143 and process-tree cleanup                            |
| Recovery after termination        | T: explicit resume preserved CANCEL-508; warning below           | D: resume unfinished session; normal resume tested                      |
| Multiple distinct sessions        | T: concurrent independent Codex probes                           | T: concurrent independent Claude probes                                 |
| File/artifact discovery           | D: file changes; must inspect workspace securely                 | D: tools can produce files; no universal artifact manifest              |

## Executed probes

The findings below came from actual provider events rather than synthetic fixtures. Generated captures have been removed after recording the results. Full transient logs remained outside the repository.

Commands ran from /private/tmp/arbeit-probes with time limits and existing CLI logins:

```sh
codex exec --ignore-user-config --json --sandbox read-only --skip-git-repo-check -C /private/tmp/arbeit-probes 'Remember the marker ARBEIT-731. Reply exactly ARBEIT-731. Do not use tools.'
codex exec resume --ignore-user-config --skip-git-repo-check --json SESSION_ID 'What was the marker in the previous message? Reply only with it. Do not use tools.'
claude -p --output-format stream-json --verbose --include-partial-messages --tools '' --strict-mcp-config --setting-sources '' --disable-slash-commands 'Remember the marker ARBEIT-731. Reply exactly ARBEIT-731.'
claude -p --resume SESSION_ID --output-format stream-json --verbose --tools '' --strict-mcp-config --setting-sources '' --disable-slash-commands 'What was the marker in the previous message? Reply with it only. Do not save memories or use tools.'
```

Codex tool probe ran `cat sample.txt`; Claude tool probe enabled and allowed only Read and read the same sample. Both returned ARBEIT-TOOL-419 with actual tool lifecycle events.

The initial Claude no-tools prompt returned XML-like Write syntax as plain text, not tool_use. No Write tool ran. The follow-up correctly recalled the marker. This is a useful negative case: text that resembles a tool call is not activity.

Codex cancellation sent SIGTERM to its process group after command item.started. Resuming the persisted ID returned CANCEL-508, but stderr reported a missing interrupted tool result. Recovery preserves available context; it does not guarantee rollback, completion of interrupted tools, or a pristine transcript. An initial resume without --skip-git-repo-check failed outside Git; corrected explicit-ID probes passed.

The ordinary execution sandbox blocked CLI session storage and network resolution. Re-running the bounded probes with host access succeeded. These failures describe the research environment, not missing provider support.

## Usage interpretation and fallbacks

Codex input_tokens includes cached input; cached_input_tokens is a subset. Do not add it again. Claude reports cache-read and cache-creation separately. Its resumed usage described the current run, while modelUsage and total_cost_usd accumulated across the conversation in the tested output. Do not sum successive cumulative snapshots. Cost estimates are not subscription charges.

Codex app-server was initialized over stdio, then account/rateLimits/read and model/list were called without inference. Both returned successfully. The selected excerpt retains usage windows and one model entry. Quota support exists, but exec alone does not provide it. App-server is a separate integration with a larger protocol; keep quotas null in the initial exec adapter.

Claude emitted a rate_limit_event with five-hour and seven-day utilization and reset timestamps. This is an account snapshot, not a task budget. Its availability outside this account/version remains unknown. Preserve absent windows as null. Do not scrape terminal UI, private files or undocumented HTTP endpoints.

For interactive choices, initially finish an attempt, record a typed question only when an explicit integration supplies one, then resume by ID with the answer. Never parse arbitrary prose into a permission approval or assume OS suspension is a provider checkpoint. Native interactive support requires separate validation.

One active attempt per logical session, bounded execution time, and explicit continuation IDs avoid ambiguous --last selection. Interrupted attempts are terminal records; later continuation is a new attempt. Never automatically replay an interrupted mutating command.

Generated files are candidates only when grounded in actual file-change events or an explicit artifact contract. Validate paths, regular-file type, size and MIME before serving. HTML isolation belongs to Phase 2.

## Official sources

These pages were fetched as Markdown during research; installed help and live output above establish the local findings.

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): JSONL items, schema output and explicit resume.
- [Codex app-server](https://developers.openai.com/codex/app-server): stdio handshake, model/list, account/rateLimits/read, turn/interrupt and interactive requests.
- [Claude Code headless](https://code.claude.com/docs/en/headless): streaming, continuation, permissions and termination behavior.
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): installed flags and input/output formats.

## Feasibility decision

A local conversation, persisted attempts, actual tool activity and available token usage are feasible now. Start with Codex exec and conservative read-only execution. Claude's CLI is feasible too, but native permission hosting, arbitrary interactive suspension, exact context occupancy and general artifact extraction are not dependencies of the first slice.

## Claude adapter verification

On 2026-10-12 the application adapter ran Claude Code 2.1.296 through the real runtime with read-only tools (Read, Grep, Glob) and `--permission-mode dontAsk`. A first execution read a sample file with an actual Read tool_use/tool_result pair and answered with its content. Explicit-ID resume answered from prior context without tools. Both attempts completed with per-run usage (cache read and creation reported separately) and a reported model. `--json-schema` produced a result `structured_output` and a synthetic StructuredOutput tool_use, which the adapter does not show as activity. Editing mode also ran for real: in an isolated worktree Claude read and wrote greeting.txt, ran the allow-listed `npm test` (observed as a passing check) and returned the structured result; Arbeit captured the actual diff and ready_for_review. Not exercised against the real CLI: denial of an unlisted Bash command, interruption and recovery, and permission-denied tool results (fixtures cover the adapter's handling). `claude auth login` printed an authorize URL and `Paste code here if prompted >`, then read the code from stdin; the redirect is a hosted page, not localhost (detected and cancelled for real; no code was submitted, so a successful code exchange is not verified). `claude auth status` printed JSON with `loggedIn` and `authMethod`; only those fields are used. Codex install and login were not run here because its CLI is absent from this machine; its status probe is `codex login status` (documented, not tested).

## Controlled editing verification

On 2026-10-09, the application adapter ran Codex 0.149.1 with workspace-write, approval policy never, explicit network/tmp write restrictions and output-schema. A committed fixture repository produced an isolated worktree. Codex changed greeting.txt from todo to ready, ran npm test with exit zero and returned a schema-constrained ready_for_review result. The source checkout remained unchanged. This verifies editing and constrained final output on this machine; it does not establish native mid-run permission support.
