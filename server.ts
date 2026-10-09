import { createServer } from "node:http";
import { mkdirSync, realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Trello } from "./src/lib/trello";
import { Dispatcher } from "./src/lib/dispatcher";
import { Store } from "./src/lib/store";
import { Runtime } from "./src/lib/runtime";
import { api } from "./src/lib/http";
import { checkOrigin } from "./src/lib/security";

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid port.");
  const root = realpathSync(process.env.ARBEIT_WORKSPACE_ROOT ?? process.cwd());
  const dataDir = resolve(process.env.ARBEIT_DATA_DIR ?? ".arbeit");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(resolve(dataDir, "arbeit.sqlite"));
  const runtime = new Runtime(store, root, {
    worktreeRoot: resolve(dataDir, "worktrees"),
  });
  const dispatcher = new Dispatcher(runtime, new Trello());
  dispatcher.start();
  const app = api(runtime, port, dispatcher);
  const server = createServer();
  const production = process.env.NODE_ENV === "production";
  let vite: import("vite").ViteDevServer | undefined;
  if (production) {
    const assets = resolve("dist");
    const html = readFileSync(resolve(assets, "index.html"), "utf8");
    app.use("/assets/*", serveStatic({ root: assets }));
    app.get("/", (c) => c.html(html));
  } else {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
  }
  const handle = getRequestListener(app.fetch);
  server.on("request", (req, res) => {
    try {
      checkOrigin(req, port);
    } catch {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Local same-origin access required." }));
      return;
    }
    if (production || req.url?.startsWith("/api/")) void handle(req, res);
    else
      vite!.middlewares(req, res, () => {
        res.writeHead(404);
        res.end();
      });
  });
  server.requestTimeout = 30_000;
  server.listen(port, "127.0.0.1", () =>
    console.log(`Arbeit is running at http://127.0.0.1:${port}`),
  );
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await dispatcher.stop();
    await runtime.shutdown();
    server.closeAllConnections();
    await vite?.close();
    store.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
void main().catch(() => {
  console.error(
    "Arbeit could not start. Check the port, workspace directory and Node version.",
  );
  process.exit(1);
});
