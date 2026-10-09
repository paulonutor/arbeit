import { realpathSync, statSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import type { IncomingMessage } from "node:http";

export class RequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function workspacePath(root: string, candidate: string): string {
  let path: string;
  try {
    path = realpathSync(candidate);
  } catch {
    throw new RequestError("Workspace directory does not exist.");
  }
  const child = relative(realpathSync(root), path);
  if (
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child) ||
    !statSync(path).isDirectory()
  ) {
    throw new RequestError(
      "Choose a directory inside the allowed workspace root.",
    );
  }
  return path;
}

export function checkOrigin(
  req: Pick<IncomingMessage, "headers" | "method">,
  port: number,
) {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!hosts.includes(req.headers.host ?? ""))
    throw new RequestError("Invalid host.", 403);
  if (req.headers["sec-fetch-site"] === "cross-site")
    throw new RequestError("Cross-site request denied.", 403);
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`)
    throw new RequestError("Invalid origin.", 403);
  if (
    !["GET", "HEAD"].includes(req.method ?? "") &&
    origin !== `http://${req.headers.host}`
  ) {
    throw new RequestError("Same-origin requests are required.", 403);
  }
}

export function textField(value: unknown, name: string, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw new RequestError(`Invalid ${name}.`);
  }
  return value.trim();
}
