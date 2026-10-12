import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { codexArgs, normalizeCodex, type Normalized } from "./codex";
import { claudeArgs, createClaudeParser } from "./claude";
import type { Mode, Provider } from "./types";

/** Provider-neutral view of one stream line. */
export interface Observation {
  events: Normalized[];
  providerSessionId?: string;
  succeeded?: boolean;
  failed?: boolean;
  /** Schema-constrained final answer delivered outside message text. */
  structured?: unknown;
  /** A finished shell command, matched by the runtime against required checks. */
  command?: { text: string; ok: boolean; exitCode: number | null };
}
export interface ArgumentContext {
  providerSessionId: string | null;
  model: string | null;
  mode: Mode;
  checks: string[];
  /** JSON Schema text and the file it was written to. */
  schema?: { json: string; path: string };
}
export interface Adapter {
  id: Provider;
  label: string;
  binary: string;
  /** Codex returns its contract as the final message text; Claude as structured output. */
  contractInMessage: boolean;
  args(context: ArgumentContext): string[];
  parser(): (event: unknown) => Observation;
}

const SESSION_ID = /^[a-zA-Z0-9-]{1,100}$/;

const codex: Adapter = {
  id: "codex",
  label: "Codex CLI",
  binary: "codex",
  contractInMessage: true,
  args: (c) => codexArgs(c.providerSessionId, c.model, c.mode, c.schema?.path),
  parser: () => (value) => {
    const event = value as Record<string, unknown>;
    const out: Observation = { events: normalizeCodex(value) };
    if (
      event.type === "thread.started" &&
      typeof event.thread_id === "string" &&
      SESSION_ID.test(event.thread_id)
    )
      out.providerSessionId = event.thread_id;
    if (event.type === "turn.completed") out.succeeded = true;
    if (event.type === "error" || event.type === "turn.failed")
      out.failed = true;
    const item = event.item as Record<string, unknown> | undefined;
    if (
      event.type === "item.completed" &&
      item?.type === "command_execution" &&
      typeof item.command === "string"
    ) {
      const exitCode =
        typeof item.exit_code === "number" ? item.exit_code : null;
      out.command = {
        text: item.command,
        exitCode,
        ok: item.status === "completed" && exitCode === 0,
      };
    }
    return out;
  },
};

const claude: Adapter = {
  id: "claude",
  label: "Claude Code",
  binary: "claude",
  contractInMessage: false,
  args: (c) =>
    claudeArgs(c.providerSessionId, c.model, c.mode, {
      schema: c.schema?.json,
      checks: c.checks,
    }),
  parser: () => {
    const parse = createClaudeParser();
    return (value) => {
      const out = parse(value);
      if (out.providerSessionId && !SESSION_ID.test(out.providerSessionId))
        delete out.providerSessionId;
      // Claude's tool_result reports success or error, not an exit status.
      return {
        ...out,
        command: out.command && {
          ...out.command,
          exitCode: out.command.ok ? 0 : null,
        },
      };
    };
  },
};

export const adapters: Record<Provider, Adapter> = { codex, claude };
export const providerIds = Object.keys(adapters) as Provider[];
export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && Object.hasOwn(adapters, value);
}
export function adapter(id: Provider): Adapter {
  return adapters[id];
}

/**
 * Finds an executable without a shell: user installs on PATH win, then the
 * directory Arbeit manages.
 */
export function resolveBinary(
  id: Provider,
  managedBin?: string,
  path = process.env.PATH ?? "",
): string | null {
  const name = adapters[id].binary;
  const names =
    process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`] : [name];
  for (const dir of [...path.split(delimiter), managedBin ?? ""]) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      try {
        if (!statSync(full).isFile()) continue;
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
