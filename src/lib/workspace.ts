import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { RequestError, workspacePath } from "./security";
import type { Review, Session } from "./types";

function git(path: string, args: string[], maxBuffer = 600_000) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: path,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
export function prepareWorkspace(
  projectPath: string,
  sessionId: string,
  root: string,
) {
  try {
    if (
      realpathSync(
        git(projectPath, ["rev-parse", "--show-toplevel"]).trim(),
      ) !== projectPath
    )
      throw new Error();
    if (git(projectPath, ["status", "--porcelain"]).trim())
      throw new RequestError(
        "Commit or stash project changes before an editing run.",
        409,
      );
    const baseCommit = git(projectPath, ["rev-parse", "HEAD"]).trim();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = resolve(root, sessionId);
    git(projectPath, [
      "worktree",
      "add",
      "-b",
      `codex/arbeit-${sessionId}`,
      path,
      baseCommit,
    ]);
    return { workspace: realpathSync(path), baseCommit };
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(
      "Editing requires a clean Git repository with a committed HEAD.",
      409,
    );
  }
}
export function discardWorkspace(
  projectPath: string,
  sessionId: string,
  root: string,
) {
  git(projectPath, ["worktree", "remove", "--force", resolve(root, sessionId)]);
  git(projectPath, ["branch", "-D", `codex/arbeit-${sessionId}`]);
}
export function reviewWorkspace(
  session: Session,
): Pick<Review, "diff" | "files" | "baseCommit" | "workspace" | "truncated"> {
  if (!session.workspace || !session.baseCommit)
    return {
      diff: "",
      files: [],
      baseCommit: null,
      workspace: null,
      truncated: false,
    };
  const path = realpathSync(session.workspace);
  let diff = git(path, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    session.baseCommit,
    "--",
    ".",
  ]);
  const files = git(path, [
    "diff",
    "--name-only",
    "-z",
    session.baseCommit,
    "--",
    ".",
  ])
    .split("\0")
    .filter(Boolean);
  const untracked = git(path, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);
  let truncated = false;
  for (const file of untracked.slice(0, 200)) {
    files.push(file);
    const absolute = join(path, file);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) {
      diff += `\nNew file ${JSON.stringify(file)} (content omitted).\n`;
      continue;
    }
    workspacePath(path, resolve(absolute, ".."));
    const data = readFileSync(absolute);
    if (data.includes(0)) {
      diff += `\nNew binary file ${JSON.stringify(file)}.\n`;
      continue;
    }
    const lines = data.toString("utf8").split("\n");
    diff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
    if (diff.length > 500_000) {
      truncated = true;
      break;
    }
  }
  truncated ||= untracked.length > 200 || diff.length > 500_000;
  return {
    diff: diff.slice(0, 500_000),
    files: [...new Set(files)].slice(0, 200),
    baseCommit: session.baseCommit,
    workspace: path,
    truncated,
  };
}
export function availableChecks(path: string): string[] {
  const file = join(path, "package.json");
  if (!existsSync(file)) return [];
  try {
    const scripts = JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
    return ["test", "typecheck", "lint", "build"].filter(
      (name) => typeof scripts[name] === "string",
    );
  } catch {
    return [];
  }
}
// Recognize only the exact requested command, including the CLI's observed shell wrapper.
export function checkCommand(
  command: unknown,
  checks: string[],
): string | null {
  if (typeof command !== "string") return null;
  const wrapped = command.match(/^\/bin\/(?:zsh|bash|sh) -lc '([^']*)'$/);
  const value = (wrapped?.[1] ?? command).trim();
  return (
    checks.find(
      (name) =>
        value === `npm run ${name}` ||
        (name === "test" && value === "npm test"),
    ) ?? null
  );
}
export function providerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("ARBEIT_") && name !== "NODE_OPTIONS",
    ),
  );
}
