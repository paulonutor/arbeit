import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Project,
  Session,
  Execution,
  AgentEvent,
  Status,
  SessionDetail,
  Mode,
  WorkflowConfig,
  TaskReceipt,
  Review,
  Provider,
} from "./types";
import { RequestError } from "./security";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL, model TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, projectId TEXT REFERENCES projects(id), title TEXT NOT NULL, provider TEXT NOT NULL, providerSessionId TEXT, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, sessionId TEXT REFERENCES sessions(id), requestedModel TEXT, status TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, exitCode INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS active_session ON executions(sessionId) WHERE status='running';
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT REFERENCES sessions(id), executionId TEXT REFERENCES executions(id), timestamp TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_events ON events(sessionId, id);`);
    for (const [table, name, definition] of [
      ["projects", "mode", "TEXT NOT NULL DEFAULT 'read-only'"],
      ["projects", "provider", "TEXT NOT NULL DEFAULT 'codex'"],
      ["projects", "checks", "TEXT NOT NULL DEFAULT '[]'"],
      ["projects", "workflow", "TEXT"],
      ["sessions", "mode", "TEXT NOT NULL DEFAULT 'read-only'"],
      ["sessions", "workspace", "TEXT"],
      ["sessions", "baseCommit", "TEXT"],
      ["sessions", "taskUrl", "TEXT"],
      ["executions", "review", "TEXT"],
    ]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === name))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS task_receipts (id TEXT PRIMARY KEY, projectId TEXT REFERENCES projects(id), cardId TEXT UNIQUE NOT NULL, cardUrl TEXT NOT NULL, sessionId TEXT REFERENCES sessions(id), status TEXT NOT NULL, message TEXT, createdAt TEXT NOT NULL);`,
    );
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY name")
      .all()
      .map((row) => this.decodeProject(row));
  }
  sessions(): Session[] {
    return this.db
      .prepare(
        "SELECT sessions.*, (SELECT status FROM executions WHERE sessionId=sessions.id ORDER BY startedAt DESC, rowid DESC LIMIT 1) AS latestStatus FROM sessions ORDER BY createdAt DESC",
      )
      .all() as unknown as Session[];
  }
  project(id: string): Project {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id=?")
      .get(id) as unknown as Project;
    if (!row) throw new RequestError("Project not found.", 404);
    return this.decodeProject(row as unknown as Record<string, unknown>);
  }
  session(id: string): Session {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(id) as unknown as Session;
    if (!row) throw new RequestError("Session not found.", 404);
    return row;
  }
  addProject(
    name: string,
    path: string,
    model: string | null,
    provider: Provider = "codex",
  ): Project {
    if (this.projects().some((p) => p.path === path))
      throw new RequestError("Workspace is already registered.", 409);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO projects(id,name,path,model,provider) VALUES (?,?,?,?,?)",
      )
      .run(id, name, path, model, provider);
    return this.project(id);
  }
  draftSession(projectId: string): Session {
    this.project(projectId);
    return {
      id: randomUUID(),
      projectId,
      title: "New session",
      provider: this.project(projectId).provider,
      providerSessionId: null,
      createdAt: new Date().toISOString(),
      mode: this.project(projectId).mode,
      workspace: null,
      baseCommit: null,
      taskUrl: null,
    };
  }
  private insertSession(session: Session) {
    this.db
      .prepare(
        "INSERT INTO sessions(id,projectId,title,provider,providerSessionId,createdAt,mode,workspace,baseCommit,taskUrl) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        session.id,
        session.projectId,
        session.title,
        session.provider,
        session.providerSessionId,
        session.createdAt,
        session.mode,
        session.workspace,
        session.baseCommit,
        session.taskUrl,
      );
  }
  detail(id: string): SessionDetail {
    const session = this.session(id);
    return {
      session,
      project: this.project(session.projectId),
      executions: this.db
        .prepare(
          "SELECT * FROM executions WHERE sessionId=? ORDER BY startedAt",
        )
        .all(id)
        .map((row) => ({
          ...row,
          review: row.review ? JSON.parse(row.review as string) : null,
        })) as unknown as Execution[],
      events: this.events(id),
    };
  }
  events(sessionId: string, after = 0): AgentEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE sessionId=? AND id>? ORDER BY id LIMIT 1000",
      )
      .all(sessionId, after)
      .map((row) => ({
        ...row,
        version: 1,
        data: JSON.parse(row.data as string),
      })) as unknown as AgentEvent[];
  }
  event(
    sessionId: string,
    executionId: string,
    type: string,
    data: Record<string, unknown>,
  ): AgentEvent {
    const timestamp = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO events(sessionId,executionId,timestamp,type,data) VALUES (?,?,?,?,?)",
      )
      .run(sessionId, executionId, timestamp, type, JSON.stringify(data));
    return {
      version: 1,
      id: Number(result.lastInsertRowid),
      sessionId,
      executionId,
      timestamp,
      type,
      data,
    };
  }
  begin(
    session: Session,
    model: string | null,
    prompt: string,
    isNew = false,
  ): string {
    if (
      this.db
        .prepare(
          "SELECT id FROM executions WHERE sessionId=? AND status='running'",
        )
        .get(session.id)
    )
      throw new RequestError("This session is already running.", 409);
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (isNew) this.insertSession(session);
      this.db
        .prepare(
          "INSERT INTO executions(id,sessionId,requestedModel,status,startedAt,endedAt,exitCode) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          id,
          session.id,
          model,
          "running",
          new Date().toISOString(),
          null,
          null,
        );
      this.event(session.id, id, "message.user", { text: prompt });
      this.event(session.id, id, "execution.started", {
        provider: session.provider,
        requestedModel: model,
      });
      if (session.title === "New session")
        this.db
          .prepare("UPDATE sessions SET title=? WHERE id=?")
          .run(prompt.slice(0, 64), session.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return id;
  }
  providerId(sessionId: string, id: string) {
    this.db
      .prepare("UPDATE sessions SET providerSessionId=? WHERE id=?")
      .run(id, sessionId);
  }
  finish(
    sessionId: string,
    id: string,
    status: Exclude<Status, "running">,
    data: Record<string, unknown>,
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db
        .prepare(
          "UPDATE executions SET status=?,endedAt=?,exitCode=? WHERE id=? AND status='running'",
        )
        .run(
          status,
          new Date().toISOString(),
          typeof data.exitCode === "number" ? data.exitCode : null,
          id,
        );
      if (r.changes) this.event(sessionId, id, `execution.${status}`, data);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private decodeProject(row: Record<string, unknown>): Project {
    return {
      ...row,
      checks: JSON.parse(row.checks as string),
      workflow: row.workflow ? JSON.parse(row.workflow as string) : null,
    } as unknown as Project;
  }
  settings(
    id: string,
    mode: Mode,
    checks: string[],
    workflow: WorkflowConfig | null,
    provider: Provider = this.project(id).provider,
  ) {
    this.project(id);
    this.db
      .prepare(
        "UPDATE projects SET mode=?,checks=?,workflow=?,provider=? WHERE id=?",
      )
      .run(
        mode,
        JSON.stringify(checks),
        workflow ? JSON.stringify(workflow) : null,
        provider,
        id,
      );
    return this.project(id);
  }
  workflow(id: string, config: WorkflowConfig) {
    this.db
      .prepare("UPDATE projects SET workflow=? WHERE id=?")
      .run(JSON.stringify(config), id);
  }
  review(id: string, review: Review) {
    this.db
      .prepare("UPDATE executions SET review=? WHERE id=?")
      .run(JSON.stringify(review), id);
  }
  receipts(projectId?: string): TaskReceipt[] {
    return (projectId
      ? this.db
          .prepare(
            "SELECT * FROM task_receipts WHERE projectId=? ORDER BY createdAt DESC",
          )
          .all(projectId)
      : this.db
          .prepare("SELECT * FROM task_receipts ORDER BY createdAt DESC")
          .all()) as unknown as TaskReceipt[];
  }
  claim(projectId: string, cardId: string, cardUrl: string): TaskReceipt {
    const value: TaskReceipt = {
      id: randomUUID(),
      projectId,
      cardId,
      cardUrl,
      sessionId: null,
      status: "claimed",
      message: null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO task_receipts VALUES (?,?,?,?,?,?,?,?)")
      .run(
        value.id,
        projectId,
        cardId,
        cardUrl,
        null,
        value.status,
        null,
        value.createdAt,
      );
    return value;
  }
  receipt(
    id: string,
    status: TaskReceipt["status"],
    sessionId: string | null,
    message: string | null = null,
  ) {
    this.db
      .prepare(
        "UPDATE task_receipts SET status=?,sessionId=?,message=? WHERE id=?",
      )
      .run(status, sessionId, message, id);
  }
  recover() {
    const rows = this.db
      .prepare("SELECT id,sessionId FROM executions WHERE status='running'")
      .all();
    for (const row of rows)
      this.finish(row.sessionId as string, row.id as string, "interrupted", {
        message:
          "The server restarted. Review the workspace before continuing.",
      });
  }
}
