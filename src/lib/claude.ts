import type { Mode } from "./types";
import type { Normalized } from "./codex";

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** What one Claude stream-json line means to the runtime. */
export interface ClaudeObservation {
  events: Normalized[];
  providerSessionId?: string;
  succeeded?: boolean;
  failed?: boolean;
  structured?: unknown;
  /** A finished Bash tool call; the runtime matches it against required checks. */
  command?: { text: string; ok: boolean };
}

const FILE_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "Glob",
  "Grep",
]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

function describeTool(raw: string): { kind: string; name: string } {
  if (raw === "Bash") return { kind: "shell", name: "Shell command" };
  if (FILE_TOOLS.has(raw)) return { kind: "file", name: raw };
  if (WEB_TOOLS.has(raw)) return { kind: "web", name: raw };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(raw);
  if (mcp) return { kind: "mcp", name: `${mcp[1]}.${mcp[2]}`.slice(0, 200) };
  return { kind: "tool", name: raw.slice(0, 200) };
}

/**
 * Stateful because tool_result blocks only carry the tool_use id. Tool input
 * and output are never retained; only the Bash command text is held in memory
 * so required checks can be recognised.
 */
export function createClaudeParser() {
  const tools = new Map<
    string,
    { kind: string; name: string; command: string | null }
  >();
  const seenMessages = new Set<string>();
  const textCounters = new Map<string, number>();
  return function parse(value: unknown): ClaudeObservation {
    const event = record(value);
    if (!event) throw new Error("Invalid event");
    const out: ClaudeObservation = { events: [] };
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.session_id === "string")
        out.providerSessionId = event.session_id;
      if (typeof event.model === "string")
        out.events.push({
          type: "model.reported",
          data: { model: event.model.slice(0, 100) },
        });
      return out;
    }
    if (event.type === "assistant") {
      const message = record(event.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const messageId =
        typeof message?.id === "string" ? message.id : String(event.uuid);
      for (const raw of content) {
        const block = record(raw);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          const n = (textCounters.get(messageId) ?? 0) + 1;
          textCounters.set(messageId, n);
          const providerItemId = `${messageId}:${n}`;
          if (block.text.trim() && !seenMessages.has(providerItemId))
            out.events.push({
              type: "message.agent",
              data: { providerItemId, text: block.text },
            });
          seenMessages.add(providerItemId);
        } else if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          // The result schema is delivered through a synthetic tool, not activity.
          if (block.name === "StructuredOutput") {
            out.structured = record(block.input) ?? undefined;
            continue;
          }
          if (tools.has(block.id)) continue;
          const input = record(block.input);
          const info = describeTool(block.name);
          tools.set(block.id, {
            ...info,
            command:
              block.name === "Bash" && typeof input?.command === "string"
                ? input.command.trim()
                : null,
          });
          out.events.push({
            type: "tool.started",
            data: {
              providerItemId: block.id,
              ...info,
              status: "in_progress",
              exitCode: null,
            },
          });
        }
        // thinking and redacted_thinking blocks are discarded.
      }
      return out;
    }
    if (event.type === "user") {
      const message = record(event.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const raw of content) {
        const block = record(raw);
        if (
          !block ||
          block.type !== "tool_result" ||
          typeof block.tool_use_id !== "string"
        )
          continue;
        const tool = tools.get(block.tool_use_id);
        if (!tool) continue;
        tools.delete(block.tool_use_id);
        const ok = block.is_error !== true;
        if (tool.command) out.command = { text: tool.command, ok };
        out.events.push({
          type: "tool.completed",
          data: {
            providerItemId: block.tool_use_id,
            kind: tool.kind,
            name: tool.name,
            status: ok ? "completed" : "failed",
            exitCode: null,
          },
        });
      }
      return out;
    }
    if (event.type === "result") {
      const usage = record(event.usage) ?? {};
      const details = record(usage.output_tokens_details);
      out.events.push({
        type: "usage",
        data: {
          scope: "execution",
          inputIncludesCached: false,
          inputTokens: count(usage.input_tokens),
          outputTokens: count(usage.output_tokens),
          cachedInputTokens: count(usage.cache_read_input_tokens),
          cacheWriteInputTokens: count(usage.cache_creation_input_tokens),
          reasoningOutputTokens: count(details?.thinking_tokens),
        },
      });
      if (event.is_error === true || event.subtype !== "success")
        out.failed = true;
      else out.succeeded = true;
      if (record(event.structured_output))
        out.structured = event.structured_output;
      return out;
    }
    return out;
  };
}

/**
 * Claude receives the prompt on stdin. `dontAsk` denies anything not on the
 * allow list instead of prompting, so unattended runs never hang on a
 * permission request and never run an unlisted tool.
 */
export function claudeArgs(
  providerSessionId: string | null,
  model: string | null,
  mode: Mode = "read-only",
  options: { schema?: string; checks?: string[] } = {},
): string[] {
  const tools = ["Read", "Grep", "Glob"];
  const allowed = [...tools];
  if (mode === "workspace-write") {
    tools.push("Edit", "Write", "Bash");
    allowed.push(
      "Edit",
      "Write",
      ...(options.checks ?? []).map(
        (name) => `Bash(${name === "test" ? "npm test" : `npm run ${name}`})`,
      ),
    );
  }
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--tools",
    tools.join(","),
    "--allowedTools",
    allowed.join(","),
  ];
  if (options.schema) args.push("--json-schema", options.schema);
  if (model) args.push("--model", model);
  if (providerSessionId) args.push("--resume", providerSessionId);
  return args;
}
