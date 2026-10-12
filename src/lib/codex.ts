import type { Mode } from "./types";
export interface Normalized {
  type: string;
  data: Record<string, unknown>;
}
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

export function normalizeCodex(value: unknown): Normalized[] {
  if (!value || typeof value !== "object") throw new Error("Invalid event");
  const event = value as Record<string, unknown>;
  if (event.type === "turn.completed") {
    const u =
      event.usage && typeof event.usage === "object"
        ? (event.usage as Record<string, unknown>)
        : {};
    return [
      {
        type: "usage",
        data: {
          scope: "execution",
          inputIncludesCached: true,
          inputTokens: count(u.input_tokens),
          outputTokens: count(u.output_tokens),
          cachedInputTokens: count(u.cached_input_tokens),
          cacheWriteInputTokens: count(u.cache_write_input_tokens),
          reasoningOutputTokens: count(u.reasoning_output_tokens),
        },
      },
    ];
  }
  const item =
    event.item && typeof event.item === "object"
      ? (event.item as Record<string, unknown>)
      : null;
  if (!item || typeof item.id !== "string") return [];
  if (
    event.type === "item.completed" &&
    item.type === "agent_message" &&
    typeof item.text === "string"
  ) {
    return [
      {
        type: "message.agent",
        data: { providerItemId: item.id, text: item.text },
      },
    ];
  }
  if (
    typeof event.type !== "string" ||
    !["item.started", "item.completed"].includes(event.type)
  )
    return [];
  const kind = {
    command_execution: "shell",
    mcp_tool_call: "mcp",
    file_change: "file",
    web_search: "web",
  }[item.type as string];
  if (!kind) return [];
  // Do not retain tool arguments, output, file contents, or reasoning.
  const name =
    kind === "mcp"
      ? `${String(item.server ?? "MCP")}.${String(item.tool ?? "tool")}`.slice(
          0,
          200,
        )
      : { shell: "Shell command", file: "File change", web: "Web search" }[
          kind as "shell" | "file" | "web"
        ];
  return [
    {
      type: event.type === "item.started" ? "tool.started" : "tool.completed",
      data: {
        providerItemId: item.id,
        kind,
        name,
        status:
          typeof item.status === "string" ? item.status.slice(0, 40) : null,
        exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
      },
    },
  ];
}

export function codexArgs(
  providerSessionId: string | null,
  model: string | null,
  mode: Mode = "read-only",
  schema?: string,
): string[] {
  const args = [
    "-s",
    mode,
    "-a",
    "never",
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "exec",
  ];
  if (providerSessionId) args.push("resume");
  args.push("--ignore-user-config", "--json");
  if (schema) args.push("--output-schema", schema);
  if (model) args.push("-m", model);
  if (providerSessionId) args.push(providerSessionId);
  args.push("-");
  return args;
}
