import { useCallback, useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { X, Play, Square, Settings, ExternalLink } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { request } from "@/lib/client";
import { ProviderSetup } from "./provider-setup";
import { providerLabel } from "./brand";
import type {
  Provider,
  Session,
  Mode,
  Project,
  TaskReceipt,
  TrelloCard,
  WorkflowConfig,
} from "@/lib/types";

type Board = {
  board: { id: string; name: string };
  lists: { id: string; name: string }[];
  labels: { id: string; name: string }[];
};
export function ProjectSettings({
  projectId,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<Mode>("read-only");
  const [provider, setProvider] = useState<Provider>("codex");
  const [checks, setChecks] = useState<string[]>([]);
  const [available, setAvailable] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false);
  const [boardRef, setBoardRef] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [workflow, setWorkflow] = useState<Partial<WorkflowConfig>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError("");
    setBoard(null);
    request<{ project: Project; checks: string[]; trelloConfigured: boolean }>(
      `/api/projects/${projectId}/settings`,
    )
      .then((data) => {
        if (cancelled) return;
        setMode(data.project.mode);
        setProvider(data.project.provider);
        setChecks(data.project.checks);
        setAvailable(data.checks);
        setConfigured(data.trelloConfigured);
        setWorkflow(data.project.workflow ?? {});
        setBoardRef(data.project.workflow?.boardId ?? "");
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, open]);
  const work = async (callback: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await callback();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="settings-overlay" />
        <Dialog.Content className="settings-dialog">
          <Dialog.Title>Project settings</Dialog.Title>
          <Dialog.Description>
            Choose how Arbeit can execute work in this project.
          </Dialog.Description>
          <Dialog.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="settings-close"
              aria-label="Close settings"
            >
              <X size={18} />
            </Button>
          </Dialog.Close>
          {error && (
            <p role="alert" className="settings-error">
              {error}
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void work(async () => {
                await request(`/api/projects/${projectId}/settings`, {
                  mode,
                  checks,
                  provider,
                });
                onSaved();
              });
            }}
          >
            <label>
              Coding agent
              <select
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as Provider)
                }
              >
                {(["codex", "claude"] as const).map((id) => (
                  <option key={id} value={id}>
                    {providerLabel(id)}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-note">
              Applies to new sessions. Existing sessions keep the agent that
              started them.
            </p>
            <label>
              Execution policy
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as Mode)}
              >
                <option value="read-only">Read only</option>
                <option value="workspace-write">
                  Allow editing in isolated Git worktrees
                </option>
              </select>
            </label>
            <p className="field-note">
              Editing requires a clean, committed Git checkout. Changes stay in
              a separate worktree for review; Arbeit does not merge them.
            </p>
            <fieldset>
              <legend>Required checks</legend>
              {available.length ? (
                available.map((name) => (
                  <label className="check-option" key={name}>
                    <input
                      type="checkbox"
                      checked={checks.includes(name)}
                      onChange={(event) =>
                        setChecks(
                          event.target.checked
                            ? [...checks, name]
                            : checks.filter((value) => value !== name),
                        )
                      }
                    />
                    {name === "test" ? "npm test" : `npm run ${name}`}
                  </label>
                ))
              ) : (
                <p className="field-note">
                  No supported npm checks were found. Automatic dispatch
                  requires at least one required check.
                </p>
              )}
            </fieldset>
            <Button type="submit" disabled={busy}>
              Save settings
            </Button>
          </form>
          <div className="settings-divider" />
          <ProviderSetup selected={provider} />
          <div className="settings-divider" />
          <h3>Trello workflow</h3>
          {!configured ? (
            <p className="field-note">
              Trello is not connected. Configure the server credentials
              described in the README, then restart Arbeit.
            </p>
          ) : (
            <>
              <label>
                Board URL or ID
                <Input
                  value={boardRef}
                  onChange={(event) => setBoardRef(event.target.value)}
                  placeholder="https://trello.com/b/…"
                />
              </label>
              <Button
                variant="outline"
                disabled={busy || !boardRef.trim()}
                onClick={() =>
                  void work(async () => {
                    let ref = boardRef.trim();
                    if (ref.startsWith("https://trello.com/b/"))
                      ref = new URL(ref).pathname.split("/")[2];
                    const data = await request<Board>(
                      `/api/trello/boards/${encodeURIComponent(ref)}`,
                    );
                    setBoard(data);
                    setWorkflow((previous) =>
                      previous.boardId === data.board.id
                        ? previous
                        : { boardId: data.board.id },
                    );
                  })
                }
              >
                Load board
              </Button>
              {board && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void work(async () => {
                      await request(
                        `/api/projects/${projectId}/workflow`,
                        workflow,
                      );
                      onSaved();
                      onOpenChange(false);
                    });
                  }}
                >
                  <p className="field-note">
                    {board.board.name} · Only cards in the ready list carrying
                    the selected label are eligible.
                  </p>
                  {(
                    [
                      ["readyListId", "Ready list"],
                      ["runningListId", "In progress list"],
                      ["reviewListId", "Review list"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <select
                        required
                        value={workflow[key] ?? ""}
                        onChange={(event) =>
                          setWorkflow({
                            ...workflow,
                            [key]: event.target.value,
                          })
                        }
                      >
                        <option value="">Choose list</option>
                        {board.lists.map((list) => (
                          <option key={list.id} value={list.id}>
                            {list.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label>
                    Explicit eligibility label
                    <select
                      required
                      value={workflow.labelId ?? ""}
                      onChange={(event) =>
                        setWorkflow({
                          ...workflow,
                          labelId: event.target.value,
                        })
                      }
                    >
                      <option value="">Choose label</option>
                      {board.labels
                        .filter((label) => label.name)
                        .map((label) => (
                          <option key={label.id} value={label.id}>
                            {label.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Button type="submit" disabled={busy}>
                    Save Trello workflow
                  </Button>
                </form>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ProjectTasks({
  project,
  onConfigure,
  onSession,
  onChanged,
}: {
  project: Project;
  onConfigure: () => void;
  onSession: (id: string) => void;
  onChanged: () => void;
}) {
  const [board, setBoard] = useState<{
    configured: boolean;
    board: { name: string } | null;
    lists: { id: string; name: string; cards: TrelloCard[] }[];
  } | null>(null);
  const [receipts, setReceipts] = useState<TaskReceipt[]>([]);
  const [current, setCurrent] = useState(project);
  const [limit, setLimit] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [settings, tasks] = await Promise.all([
      request<{ project: Project; receipts: TaskReceipt[] }>(
        `/api/projects/${project.id}/settings`,
      ),
      request<NonNullable<typeof board>>(`/api/projects/${project.id}/board`),
    ]);
    setCurrent(settings.project);
    setBoard(tasks);
    setReceipts(settings.receipts);
  }, [project.id]);
  useEffect(() => {
    const update = () => void load().catch((e) => setError(e.message));
    update();
    const timer = setInterval(update, 15000);
    return () => clearInterval(timer);
  }, [load]);
  const work = async (callback: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await callback();
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  const previous = new Set(receipts.map((receipt) => receipt.cardId));
  return (
    <div className="task-workspace">
      <div className="task-title">
        <div>
          <span className="eyebrow">{project.name}</span>
          <h1>{board?.board?.name ?? "Trello board"}</h1>
        </div>
        <Button variant="outline" size="sm" onClick={onConfigure}>
          <Settings size={14} /> Configure
        </Button>
      </div>
      <p className="task-intro">
        Trello supplies the objectives. Arbeit executes eligible work and
        retains the result for review.
      </p>
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      <section className="dispatch-controls">
        <h3>
          Automatic dispatch{" "}
          <span
            className={`status-dot ${current.workflow?.enabled ? "active" : ""}`}
          />
        </h3>
        <p>
          {current.workflow?.enabled
            ? `Armed · ${current.workflow.remaining} tasks remaining in this batch`
            : (current.workflow?.reason ??
              "Configure a Trello workflow to begin.")}
        </p>
        <div className="dispatch-actions">
          <label>
            Batch limit
            <Input
              type="number"
              min={1}
              max={10}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            />
          </label>
          {current.workflow?.enabled ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await request(`/api/projects/${project.id}/dispatch`, {
                    action: "pause",
                  });
                })
              }
            >
              <Square size={14} /> Pause dispatch
            </Button>
          ) : (
            <Button
              disabled={
                busy ||
                !current.workflow ||
                !board?.configured ||
                current.mode !== "workspace-write" ||
                !current.checks.length
              }
              onClick={() =>
                void work(async () => {
                  await request(`/api/projects/${project.id}/dispatch`, {
                    action: "arm",
                    limit,
                  });
                })
              }
            >
              <Play size={14} /> Arm batch
            </Button>
          )}
        </div>
        <p className="field-note">
          One task at a time. Failures and decisions pause dispatch. Pausing
          leaves the current execution running; use Stop in its session to
          cancel it.
        </p>
      </section>
      {board?.configured ? (
        <div className="kanban-board" aria-label="Trello Kanban board">
          {board.lists.map((list) => (
            <section className="kanban-column" key={list.id}>
              <h3>
                {list.name}
                <span>{list.cards.length}</span>
              </h3>
              {list.cards.map((card) => {
                const receipt = receipts.find(
                  (item) => item.cardId === card.id,
                );
                const eligible =
                  list.id === current.workflow?.readyListId &&
                  card.idLabels.includes(current.workflow.labelId) &&
                  !previous.has(card.id);
                return (
                  <article className="kanban-card" key={card.id}>
                    <a href={card.url} target="_blank" rel="noreferrer">
                      {card.name}
                      <ExternalLink size={12} />
                    </a>
                    {card.desc && <p>{card.desc.slice(0, 180)}</p>}
                    {receipt && (
                      <span className="field-note">
                        Execution: {receipt.status}
                      </span>
                    )}
                    {receipt?.sessionId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSession(receipt.sessionId!)}
                      >
                        Open result
                      </Button>
                    )}
                    {eligible && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          busy ||
                          current.mode !== "workspace-write" ||
                          !current.checks.length
                        }
                        onClick={() =>
                          void work(async () => {
                            const result = await request<{
                              session: { id: string };
                            }>(`/api/projects/${project.id}/tasks`, {
                              cardId: card.id,
                            });
                            onSession(result.session.id);
                          })
                        }
                      >
                        Run task
                      </Button>
                    )}
                  </article>
                );
              })}
              {!list.cards.length && <p className="field-note">No cards</p>}
            </section>
          ))}
        </div>
      ) : (
        <div className="board-empty">
          <h3>{board ? "Connect your Trello board" : "Loading board…"}</h3>
          <p>
            Configure server credentials and select the project’s Trello
            workflow to display its lists and tasks.
          </p>
          <Button variant="outline" onClick={onConfigure}>
            Configure Trello
          </Button>
        </div>
      )}
      <h3>Execution receipts</h3>
      {receipts.map((receipt) => (
        <article className="task-card" key={receipt.id}>
          <div>
            <a href={receipt.cardUrl} target="_blank" rel="noreferrer">
              Trello task ↗
            </a>
            <p>
              {receipt.status}
              {receipt.message ? ` · ${receipt.message}` : ""}
            </p>
          </div>
          <div className="receipt-actions">
            {receipt.sessionId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSession(receipt.sessionId!)}
              >
                Open result
              </Button>
            )}
            {receipt.status === "paused" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    await request(
                      `/api/projects/${project.id}/receipts/${receipt.id}`,
                      { action: receipt.sessionId ? "report" : "acknowledge" },
                    );
                  })
                }
              >
                {receipt.sessionId ? "Retry reporting" : "Acknowledge claim"}
              </Button>
            )}
          </div>
        </article>
      ))}
      {!receipts.length && (
        <p className="field-note">
          Receipts appear only when a card is claimed for execution.
        </p>
      )}
    </div>
  );
}

export function ProjectDashboard({
  project,
  sessions,
  onTasks,
  onSession,
  onConfigure,
}: {
  project: Project;
  sessions: Session[];
  onTasks: () => void;
  onSession: (id: string) => void;
  onConfigure: () => void;
}) {
  const [settings, setSettings] = useState<{
    project: Project;
    receipts: TaskReceipt[];
    trelloConfigured: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const update = () =>
      void request<NonNullable<typeof settings>>(
        `/api/projects/${project.id}/settings`,
      )
        .then((data) => {
          if (!cancelled) {
            setSettings(data);
            setError("");
          }
        })
        .catch((error) => {
          if (!cancelled) setError(error.message);
        });
    update();
    const timer = setInterval(update, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [project.id]);
  const current = settings?.project ?? project;
  const attention = settings?.receipts.filter(
    (receipt) => receipt.status === "paused",
  );
  return (
    <div className="dashboard-workspace">
      <div className="task-title">
        <div>
          <span className="eyebrow">{project.name}</span>
          <h1>Development overview</h1>
          <p className="task-intro">
            Monitor work, review results, and resolve decisions.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onTasks}>
          Open tasks
        </Button>
      </div>
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      <div className="dashboard-panels">
        <section>
          <h3>Automatic dispatch</h3>
          <strong>{current.workflow?.enabled ? "Armed" : "Paused"}</strong>
          <p>
            {current.workflow?.enabled
              ? `${current.workflow.remaining} tasks remaining`
              : (current.workflow?.reason ??
                "Configure a Trello workflow to begin.")}
          </p>
          <Button variant="ghost" size="sm" onClick={onTasks}>
            Manage dispatch →
          </Button>
        </section>
        <section>
          <h3>Execution policy</h3>
          <strong>
            {current.mode === "workspace-write"
              ? "Isolated editing"
              : "Read only"}
          </strong>
          <p>
            {current.checks.length
              ? `Required checks: ${current.checks.join(", ")}`
              : "No required checks configured."}
          </p>
          <Button variant="ghost" size="sm" onClick={onConfigure}>
            Project settings →
          </Button>
        </section>
        <section>
          <h3>Needs attention</h3>
          <strong>
            {attention ? `${attention.length} paused receipts` : "Loading…"}
          </strong>
          <p>
            {settings && !settings.trelloConfigured
              ? "Trello server credentials are not configured."
              : "Review execution results and resolve paused claims in Tasks."}
          </p>
          <Button variant="ghost" size="sm" onClick={onTasks}>
            Review tasks →
          </Button>
        </section>
      </div>
      <h3>Recent sessions</h3>
      <div className="dashboard-sessions">
        {sessions.slice(0, 8).map((session) => (
          <button key={session.id} onClick={() => onSession(session.id)}>
            <span>
              <strong>{session.title}</strong>
              <small>
                {providerLabel(session.provider)} ·{" "}
                {session.latestStatus ?? "Draft"}
              </small>
            </span>
            <time>{new Date(session.createdAt).toLocaleDateString()}</time>
          </button>
        ))}
      </div>
      {!sessions.length && (
        <p className="field-note">
          No executions yet. Eligible Trello tasks supply the objectives.
        </p>
      )}
    </div>
  );
}
