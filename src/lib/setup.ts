import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { adapter, providerIds, resolveBinary } from "./providers";
import { RequestError } from "./security";
import { providerEnvironment } from "./workspace";
import type { Provider } from "./types";

/** Fixed, reviewable commands. Nothing here is built from request input. */
const PACKAGES: Record<Provider, string> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
};
const LOGIN_ARGS: Record<Provider, string[]> = {
  codex: ["login"],
  claude: ["auth", "login"],
};
const STATUS_ARGS: Record<Provider, string[]> = {
  codex: ["login", "status"],
  claude: ["auth", "status"],
};
const LOGIN_HOSTS = [
  "claude.ai",
  "claude.com",
  "anthropic.com",
  "openai.com",
  "chatgpt.com",
];

export type JobKind = "install" | "login";
export interface Job {
  kind: JobKind;
  state: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  message: string | null;
  /** Sign-in page printed by the provider CLI; never a credential. */
  url: string | null;
}
export interface ProviderStatus {
  id: Provider;
  label: string;
  installed: boolean;
  version: string | null;
  managed: boolean;
  /** null when it could not be determined, for example when not installed. */
  authenticated: boolean | null;
  authMethod: string | null;
  /** npm package Arbeit installs into its own data directory. */
  package: string;
  installSupported: boolean;
  job: Job | null;
}

interface Launch {
  command: string;
  args: string[];
}
interface Options {
  /** Directory Arbeit may install provider CLIs into. */
  directory: string;
  timeoutMs?: number;
  /** Test seam: rewrite a launch before it is spawned. */
  runner?: (target: "npm" | Provider, launch: Launch) => Launch;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function loginUrl(text: string): string | null {
  for (const match of text
    .replace(ANSI, "")
    .matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(match[0].replace(/[.,;)]+$/, ""));
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        LOGIN_HOSTS.some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      )
        return url.toString();
    } catch {
      /* not a URL */
    }
  }
  return null;
}

export class ProviderSetup {
  private jobs = new Map<Provider, Job & { child?: ChildProcess }>();
  constructor(private options: Options) {}

  get managedBin() {
    return join(this.options.directory, "node_modules", ".bin");
  }

  private launch(target: "npm" | Provider, args: string[], command?: string) {
    const base = { command: command ?? target, args };
    return this.options.runner?.(target, base) ?? base;
  }

  /** Runs a short diagnostic command without a shell, keeping bounded output. */
  private probe(
    launch: Launch,
  ): Promise<{ code: number | null; text: string }> {
    return new Promise((resolve) => {
      let text = "";
      let child: ChildProcess;
      try {
        child = spawn(launch.command, launch.args, {
          env: providerEnvironment(),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve({ code: null, text: "" });
        return;
      }
      const collect = (chunk: Buffer) => {
        if (text.length < 20_000) text += chunk.toString("utf8");
      };
      child.stdout!.on("data", collect);
      child.stderr!.on("data", collect);
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ code: null, text: "" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, text });
      });
    });
  }

  private binary(id: Provider) {
    return resolveBinary(id, this.managedBin) ?? adapter(id).binary;
  }

  async status(id?: Provider): Promise<ProviderStatus[]> {
    return Promise.all(
      (id ? [id] : providerIds).map((provider) => this.inspect(provider)),
    );
  }

  private async inspect(id: Provider): Promise<ProviderStatus> {
    const found = resolveBinary(id, this.managedBin);
    const result: ProviderStatus = {
      id,
      label: adapter(id).label,
      installed: false,
      version: null,
      managed: false,
      authenticated: null,
      authMethod: null,
      package: PACKAGES[id],
      installSupported: process.platform !== "win32",
      job: this.publicJob(id),
    };
    if (!found && !this.options.runner) return result;
    const command = found ?? adapter(id).binary;
    const version = await this.probe(this.launch(id, ["--version"], command));
    if (version.code !== 0) return result;
    result.installed = true;
    result.managed = found?.startsWith(this.managedBin) ?? false;
    result.version =
      /\d+\.\d+\.\d+[\w.+-]*/.exec(version.text.replace(ANSI, ""))?.[0] ?? null;
    const auth = await this.probe(this.launch(id, STATUS_ARGS[id], command));
    result.authenticated = auth.code === 0;
    const text = auth.text.replace(ANSI, "");
    if (id === "claude") {
      try {
        const value = JSON.parse(text);
        if (typeof value.loggedIn === "boolean")
          result.authenticated = value.loggedIn;
        if (typeof value.authMethod === "string")
          result.authMethod = value.authMethod.slice(0, 40);
      } catch {
        /* exit code decides */
      }
    } else if (result.authenticated) {
      result.authMethod = /ChatGPT/i.test(text)
        ? "ChatGPT"
        : /API key/i.test(text)
          ? "API key"
          : null;
    }
    return result;
  }

  private publicJob(id: Provider): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const { child: _child, ...rest } = job;
    void _child;
    return rest;
  }

  private start(
    id: Provider,
    kind: JobKind,
    launch: Launch,
    timeoutMs: number,
    cwd?: string,
  ): Job {
    if (this.jobs.get(id)?.state === "running")
      throw new RequestError(
        `${adapter(id).label} setup is already running.`,
        409,
      );
    const job: Job & { child?: ChildProcess } = {
      kind,
      state: "running",
      startedAt: new Date().toISOString(),
      message: kind === "install" ? "Installing…" : "Waiting for sign-in…",
      url: null,
    };
    this.jobs.set(id, job);
    let tail = "";
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd,
        env: providerEnvironment(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      job.state = "failed";
      job.message = "The command could not be started.";
      return this.publicJob(id)!;
    }
    job.child = child;
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(name);
        else process.kill(-child.pid, name);
      } catch {
        /* already gone */
      }
    };
    const onData = (chunk: Buffer) => {
      // Only a bounded in-memory tail is kept; it is not persisted or logged.
      tail = (tail + chunk.toString("utf8")).slice(-4000);
      if (kind === "login" && !job.url) job.url = loginUrl(tail);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    const timer = setTimeout(() => {
      job.message = "Timed out.";
      signal("SIGTERM");
    }, timeoutMs);
    child.on("error", () => {
      job.state = "failed";
      job.message = `${launch.command} could not be started.`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal("SIGKILL");
      job.child = undefined;
      if (job.state === "cancelled") return;
      if (job.state === "failed") return;
      job.url = null;
      if (code === 0) {
        job.state = "succeeded";
        job.message = null;
      } else {
        job.state = "failed";
        const last = tail
          .replace(ANSI, "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);
        job.message =
          job.message === "Timed out."
            ? job.message
            : `Exited with code ${code ?? "unknown"}${last ? `: ${last.slice(0, 200)}` : "."}`;
      }
    });
    return this.publicJob(id)!;
  }

  install(id: Provider, busy = false): Job {
    if (process.platform === "win32")
      throw new RequestError(
        `Automatic install is unavailable on Windows. Run: npm install -g ${PACKAGES[id]}`,
        501,
      );
    if (busy)
      throw new RequestError(
        "Wait for the active execution before installing.",
        409,
      );
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    return this.start(
      id,
      "install",
      this.launch("npm", [
        "install",
        "--prefix",
        this.options.directory,
        "--no-audit",
        "--no-fund",
        PACKAGES[id],
      ]),
      this.options.timeoutMs ?? 300_000,
    );
  }

  login(id: Provider): Job {
    if (!resolveBinary(id, this.managedBin) && !this.options.runner)
      throw new RequestError(`Install ${adapter(id).label} first.`, 409);
    return this.start(
      id,
      "login",
      this.launch(id, LOGIN_ARGS[id], this.binary(id)),
      this.options.timeoutMs ?? 600_000,
    );
  }

  cancel(id: Provider) {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running" || !job.child?.pid)
      throw new RequestError("Nothing is running.", 409);
    job.state = "cancelled";
    job.message = "Cancelled.";
    job.url = null;
    try {
      if (process.platform === "win32") job.child.kill("SIGTERM");
      else process.kill(-job.child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  shutdown() {
    for (const id of this.jobs.keys())
      try {
        this.cancel(id);
      } catch {
        /* not running */
      }
  }
}
