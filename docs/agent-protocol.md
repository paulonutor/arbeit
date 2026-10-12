# Agent event protocol v1

Each event has `version: 1`, a durable monotonic `id`, `sessionId`, `executionId`, ISO UTC `timestamp`, `type`, and `data`. IDs are assigned by SQLite only after insertion. SSE uses `id` as its replay cursor. Provider IDs remain data, never application primary keys.

| Type                  | Data                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| message.user          | text                                                                                                                                                   |
| message.agent         | text, providerItemId                                                                                                                                   |
| tool.started          | providerItemId, kind, name, status                                                                                                                     |
| tool.completed        | providerItemId, kind, name, status, nullable exitCode                                                                                                  |
| model.reported        | model (the provider-reported model; the requested model stays on execution.started)                                                                    |
| usage                 | scope: execution, inputIncludesCached, inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens; unknown values null |
| execution.started     | requestedModel, provider                                                                                                                               |
| execution.completed   | exitCode                                                                                                                                               |
| execution.failed      | safe message, nullable exitCode                                                                                                                        |
| execution.cancelled   | exitCode, signal                                                                                                                                       |
| execution.timed_out   | exitCode, signal                                                                                                                                       |
| execution.interrupted | safe message                                                                                                                                           |

Messages are complete authoritative provider items. v1 does not claim token-level deltas. A later adapter can add message.delta with stable item IDs and documented reconciliation.

Claude mapping: system/init supplies the continuation ID and model.reported. Assistant text blocks emit message.agent; tool_use blocks emit tool.started and the matching user tool_result emits tool.completed (status failed when is_error). thinking blocks, tool input and output, and stream_event deltas are discarded. The synthetic StructuredOutput tool is not activity. Only a result with subtype success and is_error false counts as provider success. Result `usage` is the current run; `modelUsage` and cost are cumulative and are not recorded. Claude's tool_result has no exit status, so exitCode is null (a passing check records 0 only because the tool reported success). Usage sets inputIncludesCached true for Codex, where cached input is a subset, and false for Claude, where cache read and creation are reported separately.

Codex mapping: thread.started updates the session's continuation ID; item.completed agent_message emits message.agent. command_execution maps to shell; mcp_tool_call maps to MCP using server/tool fields; file_change maps to file activity. Tool arguments and output are omitted from retained summaries. reasoning items are discarded before persistence. turn.completed emits attempt usage and records provider success, but the execution becomes complete only after zero process exit. turn.failed/error flags failure; raw diagnostic text is not retained.

Only actual item lifecycle events emit tool activity. Unknown items produce no inferred state. Interrupted tools need not have a completion event. There is exactly one terminal execution event per attempt. Cancellation, timeout and failure cannot become success because of a late provider event.

`Last-Event-ID` or `after` resumes after a committed sequence. Reads are scoped to the selected session; global sequence gaps are allowed. Replayed events retain their ID, and clients deduplicate by ID. Heartbeats are transport comments and never stored as agent events. Disconnects close only the subscriber, not the execution.

Editing adds check.completed (configured name, status, exitCode), review.ready (outcome, summary, files and checks; the full review is stored on the execution), and interaction.requested (question). These follow an observed check command, actual workspace inspection and the enforced final-response schema. Decisions occur between executions; general artifacts and native mid-turn permission requests remain unimplemented. Never treat freeform prose as an approval request or tool result. Never include internal reasoning, credentials, raw init metadata, or subscription credit identifiers.

Usage is reported data, not a budget or price. Cached input is a subset of Codex input. Missing values are null. Cumulative Claude modelUsage must not be summed as per-execution counts by a future adapter.

## Editing result contract

Claude receives the same schema through --json-schema and returns it as structured_output. Codex exec receives an output schema requiring `{outcome, summary, question}`. Outcomes are `ready_for_review`, `needs_input`, or `blocked`; question is a string or null. Arbeit validates that contract and requires a question for needs_input. It records actual Git baseline/diff/files and one result per configured npm check. Only matching completed provider command events count as checks; prose claims do not. Missing/failed checks downgrade ready_for_review to blocked. Execution completion describes provider process success; review outcome separately describes whether the work is ready.
