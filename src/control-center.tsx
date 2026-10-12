import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  Plus,
  Square,
  Terminal,
  Circle,
  Search,
  ChevronDown,
  Check,
  Menu,
  X,
  PanelRightClose,
  Settings,
  ChartNoAxesColumn,
  PanelsTopLeft,
  SlidersHorizontal,
  Timer,
  Cpu,
  FileText,
  Database,
  Coins,
  Wrench,
  MoreHorizontal,
  ListTodo,
  UserRound,
  LayoutDashboard,
  Columns3,
  MessagesSquare,
} from "lucide-react";
import { request } from "@/lib/client";
import {
  ProjectSettings,
  ProjectTasks,
  ProjectDashboard,
} from "@/components/project-workflow";
import Markdown from "react-markdown";
import { Select, DropdownMenu, Dialog } from "radix-ui";
import { ArbeitMark, ProviderMark, providerLabel } from "@/components/brand";
import { sessionGroup, statusLabel, toolDuration } from "@/lib/presentation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type {
  AgentEvent,
  Project,
  Provider,
  Session,
  SessionDetail,
} from "@/lib/types";

function mergeEvents(previous: AgentEvent[], incoming: AgentEvent[]) {
  return [
    ...new Map(
      [...previous, ...incoming].map((event) => [event.id, event]),
    ).values(),
  ].sort((a, b) => a.id - b.id);
}
const number = (value: unknown) =>
  typeof value === "number" ? value.toLocaleString() : "Unavailable";

export default function ControlCenter() {
  const [showNavigation, setShowNavigation] = useState(false);
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projectId, setProjectId] = useState("");
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [root, setRoot] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<"dashboard" | "tasks" | "sessions">(
    "dashboard",
  );
  const [showProject, setShowProject] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => {
    setShowDetails(window.matchMedia("(min-width: 1000px)").matches);
  }, []);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [model, setModel] = useState("");
  const [newProvider, setNewProvider] = useState<Provider>("codex");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const usagePanel = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const data = await request<{
      projects: Project[];
      sessions: Session[];
      workspaceRoot: string;
    }>("/api/bootstrap");
    setProjects(data.projects);
    setSessions(data.sessions);
    setRoot(data.workspaceRoot);
    setProjectId((current) => current || data.projects[0]?.id || "");
    return data;
  }, []);
  useEffect(() => {
    refresh()
      .then((data) => {
        const saved = localStorage.getItem("arbeit.session");
        const chosen =
          data.sessions.find((s) => s.id === saved) ?? data.sessions[0];
        setSelected(chosen?.id ?? "");
        if (chosen) setProjectId(chosen.projectId);
        setLoaded(true);
      })
      .catch((e) => {
        setError(e.message);
        setLoaded(true);
      });
  }, [refresh]);

  useEffect(() => {
    if (view === "sessions") return;
    const timer = setInterval(
      () => void refresh().catch((error) => setError(error.message)),
      15000,
    );
    return () => clearInterval(timer);
  }, [view, refresh]);

  useEffect(() => {
    setEvents([]);
    setDetail(null);
    setConnected(false);
    if (!selected) return;
    localStorage.setItem("arbeit.session", selected);
    let cancelled = false;
    let stream: EventSource | undefined;
    const updateDetail = async () => {
      const data = await request<SessionDetail>(`/api/sessions/${selected}`);
      if (!cancelled) {
        setDetail(data);
        setEvents((previous) => mergeEvents(previous, data.events));
      }
      return data;
    };
    updateDetail()
      .then((data) => {
        if (cancelled) return;
        const after = data.events.at(-1)?.id ?? 0;
        stream = new EventSource(
          `/api/sessions/${selected}/events?after=${after}`,
        );
        stream.onopen = () => {
          if (!cancelled) {
            setConnected(true);
            void updateDetail().catch((e) => setError(e.message));
          }
        };
        stream.onerror = () => {
          if (!cancelled) setConnected(false);
        };
        stream.onmessage = (message) => {
          const event = JSON.parse(message.data) as AgentEvent;
          setEvents((previous) => mergeEvents(previous, [event]));
          if (event.type.startsWith("execution.")) {
            void updateDetail()
              .then(() => refresh())
              .catch((e) => setError(e.message));
          }
        };
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      stream?.close();
    };
  }, [selected, refresh]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  const createSession = () => {
    setSelected("");
    setDetail(null);
    setEvents([]);
    setPrompt("");
    setError("");
    setShowProject(false);
    setView("sessions");
    setShowNavigation(false);
    localStorage.removeItem("arbeit.session");
  };
  const send = () =>
    action(async () => {
      if (!prompt.trim() || !projectId) return;
      let id = selected;
      if (!id) {
        const result = await request<{ session: Session; executionId: string }>(
          "/api/sessions",
          { projectId, text: prompt },
        );
        id = result.session.id;
        setSelected(id);
      } else {
        await request(`/api/sessions/${id}/messages`, { text: prompt });
        const data = await request<SessionDetail>(`/api/sessions/${id}`);
        setDetail(data);
        setEvents((previous) => mergeEvents(previous, data.events));
      }
      setPrompt("");
      await refresh();
    });
  const latest = detail?.executions.at(-1);
  const running = latest?.status === "running";
  const policy =
    detail?.session.mode ??
    projects.find((project) => project.id === projectId)?.mode ??
    "read-only";
  const executionStatus = running
    ? "running"
    : latest?.review?.outcome === "needs_input"
      ? "Waiting for input"
      : latest?.review?.outcome === "ready_for_review"
        ? "Ready for review"
        : latest?.review?.outcome === "blocked"
          ? "Needs attention"
          : (latest?.status.replaceAll("_", " ") ?? "Draft");
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowSearch(true);
      } else if (event.key.toLowerCase() === "n" && projectId && !busy) {
        event.preventDefault();
        createSession();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  const usage = events.filter((e) => e.type === "usage").at(-1)?.data;
  const project = projects.find((p) => p.id === projectId);
  const activeProvider =
    detail?.session.provider ?? project?.provider ?? "codex";
  const agentName = providerLabel(activeProvider);
  const toolCalls = events.filter((e) => e.type === "tool.started").length;
  const completedTools = new Set(
    events
      .filter((event) => event.type === "tool.completed")
      .map((event) => `${event.executionId}:${event.data.providerItemId}`),
  );
  const visibleEvents = events.filter(
    (event) =>
      ![
        "usage",
        "execution.started",
        "check.completed",
        "review.ready",
        "interaction.requested",
        "execution.completed",
      ].includes(event.type) &&
      !(
        event.type === "tool.started" &&
        completedTools.has(`${event.executionId}:${event.data.providerItemId}`)
      ),
  );

  const visibleSessions = sessions.filter(
    (session) => session.projectId === projectId,
  );
  const groups = ["Today", "Yesterday", "This week", "Earlier"]
    .map((label) => ({
      label,
      sessions: visibleSessions.filter(
        (session) => sessionGroup(session.createdAt) === label,
      ),
    }))
    .filter((group) => group.sessions.length);
  const elapsed = latest?.endedAt
    ? `${Math.round((Date.parse(latest.endedAt) - Date.parse(latest.startedAt)) / 1000)}s`
    : running
      ? "Running"
      : "Unavailable";
  const timeline = events.filter(
    (event) =>
      event.executionId === latest?.id &&
      (event.type.startsWith("execution.") || event.type === "tool.completed"),
  );
  const displayStatus = statusLabel(executionStatus);
  const statusClass = running
    ? "active"
    : latest?.status === "completed" &&
        latest?.review?.outcome !== "blocked" &&
        latest?.review?.outcome !== "needs_input"
      ? "complete"
      : latest && latest.status !== "completed"
        ? "attention"
        : "idle";

  return (
    <div className="control-center">
      <Dialog.Root
        open={showSearch}
        onOpenChange={(open) => {
          setShowSearch(open);
          if (!open) setSearch("");
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="settings-overlay" />
          <Dialog.Content className="settings-dialog session-search-dialog">
            <Dialog.Title>Search sessions</Dialog.Title>
            <Dialog.Description>
              Find a session in {project?.name ?? "the selected project"}.
            </Dialog.Description>
            <Input
              aria-label="Search session titles"
              placeholder="Search sessions…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Dialog.Close asChild>
              <Button
                className="settings-close"
                variant="ghost"
                size="icon"
                aria-label="Close search"
              >
                <X size={18} />
              </Button>
            </Dialog.Close>
            <div className="session-search-results">
              {visibleSessions
                .filter((session) =>
                  session.title.toLowerCase().includes(search.toLowerCase()),
                )
                .map((session) => (
                  <button
                    key={session.id}
                    onClick={() => {
                      setSelected(session.id);
                      setView("sessions");
                      setShowProject(false);
                      setPrompt("");
                      setShowSearch(false);
                      setSearch("");
                      setShowNavigation(false);
                    }}
                  >
                    <span>{session.title}</span>
                    <small>
                      {providerLabel(session.provider)} ·{" "}
                      {statusLabel(session.latestStatus ?? "draft")}
                    </small>
                  </button>
                ))}
              {!visibleSessions.some((session) =>
                session.title.toLowerCase().includes(search.toLowerCase()),
              ) && <p className="sidebar-empty">No matching sessions.</p>}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {projectId && (
        <ProjectSettings
          projectId={projectId}
          open={showSettings}
          onOpenChange={setShowSettings}
          onSaved={() => {
            void refresh();
          }}
        />
      )}
      {showNavigation && (
        <button
          className="navigation-backdrop"
          aria-label="Close navigation"
          onClick={() => setShowNavigation(false)}
        />
      )}
      <aside className={`sidebar ${showNavigation ? "navigation-open" : ""}`}>
        <Button
          variant="ghost"
          size="icon"
          className="navigation-close"
          aria-label="Close navigation"
          onClick={() => setShowNavigation(false)}
        >
          <X size={18} />
        </Button>
        <div className="brand">
          <div className="brand-symbol">
            <ArbeitMark />
          </div>
          <span>Arbeit</span>
        </div>
        <div className="project-picker">
          <Select.Root
            value={projectId}
            onValueChange={(value) => {
              if (value === "settings") {
                setShowSettings(true);
                setShowNavigation(false);
                return;
              }
              if (value === "add") {
                setPath(root);
                setShowProject(true);
                setShowNavigation(false);
                return;
              }
              setShowProject(false);
              setPrompt("");
              setProjectId(value);
              setSelected(
                sessions.find((session) => session.projectId === value)?.id ??
                  "",
              );
            }}
          >
            <Select.Trigger
              className="project-selector"
              aria-label="Select project"
            >
              <span className="project-icon">
                <PanelsTopLeft size={18} />
              </span>
              <span className="project-selection">
                <Select.Value placeholder="Select project" />
                <span className="project-path">
                  {project?.path ?? "Choose a repository"}
                </span>
              </span>
              <ChevronDown size={13} />
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                className="project-menu"
                position="popper"
                sideOffset={10}
              >
                <Select.Viewport>
                  {projects.map((project) => (
                    <Select.Item
                      className="project-option"
                      key={project.id}
                      value={project.id}
                    >
                      <Select.ItemText>{project.name}</Select.ItemText>
                      <Select.ItemIndicator>
                        <Check size={14} />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                  <Select.Separator className="project-divider" />
                  {projectId && (
                    <Select.Item className="project-option" value="settings">
                      <Select.ItemText>Project settings…</Select.ItemText>
                    </Select.Item>
                  )}
                  <Select.Item className="project-option" value="add">
                    <Select.ItemText>Add project…</Select.ItemText>
                  </Select.Item>
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
        <nav className="primary-navigation" aria-label="Main navigation">
          {(
            [
              { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
              { id: "tasks", label: "Tasks", icon: Columns3 },
              { id: "sessions", label: "Sessions", icon: MessagesSquare },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={view === id ? "page" : undefined}
              onClick={() => {
                setView(id);
                setShowProject(false);
                setShowNavigation(false);
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="session-list-heading">
          <span>Sessions</span>
          <div className="session-heading-actions">
            <Button
              className="session-icon-button"
              variant="ghost"
              size="icon"
              aria-label="Search sessions"
              title="Search sessions (⌘ K)"
              onClick={() => setShowSearch(true)}
            >
              <Search size={15} />
            </Button>
            <Button
              className="session-icon-button"
              variant="ghost"
              size="icon"
              aria-label="New session"
              title="New session (⌘ N)"
              disabled={!projectId || busy}
              onClick={createSession}
            >
              <Plus size={16} />
            </Button>
          </div>
        </div>
        <nav className="session-list" aria-label="Sessions">
          {groups.map((group) => (
            <div className="session-group" key={group.label}>
              <h3>{group.label}</h3>
              {group.sessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-button ${selected === session.id ? "selected" : ""}`}
                  onClick={() => {
                    setSelected(session.id);
                    setShowProject(false);
                    setView("sessions");
                    setPrompt("");
                    setShowNavigation(false);
                  }}
                >
                  <span
                    className={`session-dot ${session.latestStatus === "completed" ? "complete" : session.latestStatus === "running" ? "active" : session.latestStatus ? "attention" : "idle"}`}
                  />
                  <span className="session-copy">
                    <span className="session-title">{session.title}</span>
                    <span className="session-provider">
                      {providerLabel(session.provider)} ·{" "}
                      {statusLabel(session.latestStatus ?? "draft")}
                    </span>
                  </span>
                  <time>
                    {group.label === "Today" || group.label === "Yesterday"
                      ? new Date(session.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })
                      : new Date(session.createdAt).toLocaleDateString([], {
                          weekday: "short",
                        })}
                  </time>
                </button>
              ))}
            </div>
          ))}
          {!visibleSessions.length && (
            <p className="sidebar-empty">No executions yet.</p>
          )}
        </nav>
        <div className="sidebar-footer">
          <button
            onClick={() => {
              setView("sessions");
              setShowDetails(true);
              setShowNavigation(false);
              requestAnimationFrame(() =>
                usagePanel.current?.scrollIntoView({ block: "nearest" }),
              );
            }}
          >
            <ChartNoAxesColumn size={18} /> Usage
          </button>
          <button
            disabled={!projectId}
            onClick={() => {
              setShowSettings(true);
              setShowNavigation(false);
            }}
          >
            <Settings size={18} /> Settings{" "}
            <span className="local-profile" aria-label="Local user">
              <UserRound size={14} />
            </span>
            <ChevronRight size={17} />
          </button>
        </div>
      </aside>

      <main
        className={`main-workspace ${view === "sessions" && showDetails && !showProject && projects.length ? "with-details" : ""}`}
      >
        <header className="topbar">
          <Button
            variant="ghost"
            size="icon"
            className="navigation-toggle"
            aria-label="Open navigation"
            onClick={() => setShowNavigation(true)}
          >
            <Menu size={18} />
          </Button>
          <div className="session-header">
            <h2 title={view === "sessions" ? detail?.session.title : undefined}>
              {view === "sessions"
                ? (detail?.session.title ?? "New session")
                : view === "tasks"
                  ? "Tasks"
                  : "Dashboard"}
            </h2>
            <div className="session-header-meta">
              <span>{project?.name ?? "Select project"}</span>
              {view === "sessions" && <span>·</span>}
              {view === "sessions" && detail && (
                <>
                  <time>
                    {new Date(detail.session.createdAt).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </time>
                  <span>·</span>
                  <time>
                    {new Date(detail.session.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </time>
                </>
              )}
            </div>
          </div>
          {view === "sessions" && (
            <div className="header-controls">
              <button
                className="status-pill"
                aria-label="Toggle session details"
                onClick={() => setShowDetails(!showDetails)}
              >
                <span className={`status-dot ${statusClass}`} />
                {displayStatus}
                <ChevronDown size={13} />
              </button>
              <div className="provider-control">
                <span>
                  <ProviderMark provider={activeProvider} size={19} />{" "}
                  {agentName}
                </span>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Session actions"
                    >
                      <MoreHorizontal size={17} />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="project-menu action-menu"
                      align="end"
                      sideOffset={8}
                    >
                      <DropdownMenu.Item
                        className="project-option"
                        disabled={!projectId}
                        onSelect={() => setView("tasks")}
                      >
                        <ListTodo size={16} />
                        {"Development tasks"}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className="project-option"
                        onSelect={() => setShowDetails(!showDetails)}
                      >
                        <PanelRightClose size={16} />
                        Session details
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className="project-option"
                        disabled={!projectId}
                        onSelect={() => setShowSettings(true)}
                      >
                        <Settings size={16} />
                        Project settings
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </div>
          )}
        </header>
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <Button variant="ghost" size="sm" onClick={() => setError("")}>
              Dismiss
            </Button>
          </div>
        )}
        <div className="workspace-content">
          <section
            className="conversation"
            aria-label={
              view === "sessions"
                ? "Session execution"
                : view === "tasks"
                  ? "Project tasks"
                  : "Project dashboard"
            }
          >
            {view === "dashboard" && !showProject && project ? (
              <ProjectDashboard
                project={project}
                sessions={sessions.filter(
                  (session) => session.projectId === project.id,
                )}
                onTasks={() => setView("tasks")}
                onConfigure={() => setShowSettings(true)}
                onSession={(id) => {
                  setSelected(id);
                  setView("sessions");
                }}
              />
            ) : view === "tasks" && !showProject && project ? (
              <ProjectTasks
                project={project}
                onConfigure={() => setShowSettings(true)}
                onSession={(id) => {
                  setSelected(id);
                  setView("sessions");
                  void refresh();
                }}
                onChanged={() => {
                  void refresh();
                }}
              />
            ) : showProject || (loaded && !projects.length) ? (
              <div className="onboarding">
                <span className="eyebrow">Your machine. Your workspace.</span>
                <h1>Give your agent a place to work.</h1>
                <p>
                  Connect a repository for agent work. Executions and their
                  activity stay on this machine.
                </p>
                <form
                  className="project-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      const p = await request<Project>("/api/projects", {
                        name,
                        path: path || root,
                        model,
                        provider: newProvider,
                      });
                      await refresh();
                      createSession();
                      setProjectId(p.id);
                      setShowProject(false);
                      setName("");
                      setModel("");
                    });
                  }}
                >
                  <label>
                    Project name
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="My project"
                      required
                      maxLength={200}
                    />
                  </label>
                  <label>
                    Repository directory
                    <Input
                      value={path || root}
                      onChange={(e) => setPath(e.target.value)}
                      required
                    />
                    <span className="field-note">Allowed root: {root}</span>
                  </label>
                  <label>
                    Coding agent
                    <select
                      value={newProvider}
                      onChange={(e) =>
                        setNewProvider(e.target.value as Provider)
                      }
                    >
                      <option value="codex">Codex CLI</option>
                      <option value="claude">Claude Code</option>
                    </select>
                    <span className="field-note">
                      Install and sign in from Project settings.
                    </span>
                  </label>
                  <label>
                    Model <span className="muted">optional</span>
                    <Input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="Use provider default"
                      maxLength={100}
                    />
                  </label>
                  <div className="form-actions">
                    <Button type="submit" disabled={busy}>
                      Add project
                    </Button>
                    {projects.length > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setShowProject(false)}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </form>
              </div>
            ) : (
              <>
                <div className="conversation-feed" aria-live="polite">
                  {!events.length && (
                    <div className="session-intro">
                      <span className="eyebrow">
                        {project?.name ?? "Arbeit"} / New execution
                      </span>
                      <h1>Give your agent an objective.</h1>
                      <p>
                        Describe the outcome and constraints. The agent runs
                        independently; follow its activity here and step in when
                        needed.
                      </p>
                    </div>
                  )}
                  {visibleEvents.map((event) =>
                    event.type.startsWith("message.") ? (
                      <article
                        className={`message ${event.type === "message.user" ? "user-message" : "agent-message"}`}
                        key={event.id}
                      >
                        <div className="message-avatar" aria-hidden="true">
                          {event.type === "message.user" ? (
                            <UserRound size={18} />
                          ) : (
                            <ProviderMark provider={activeProvider} size={25} />
                          )}
                        </div>
                        <div className="message-heading">
                          <span>
                            {event.type === "message.user" ? "You" : agentName}
                          </span>
                          <time>
                            {new Date(event.timestamp).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                        </div>
                        <div className="message-text">
                          {event.type === "message.user" ? (
                            String(event.data.text)
                          ) : (
                            <Markdown
                              skipHtml
                              components={{
                                a: ({ children, ...props }) => (
                                  <a
                                    {...props}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {children}
                                  </a>
                                ),
                              }}
                            >
                              {String(event.data.text)}
                            </Markdown>
                          )}
                        </div>
                      </article>
                    ) : event.type.startsWith("tool.") ? (
                      <div className="tool-row" key={event.id}>
                        <span className="tool-icon">
                          {event.data.kind === "file" ? (
                            <FileText size={21} />
                          ) : (
                            <Terminal size={21} />
                          )}
                        </span>
                        <span className="tool-copy">
                          <span>{String(event.data.name)}</span>
                          <small>
                            {event.data.kind === "file"
                              ? "Workspace file activity"
                              : event.data.kind === "shell"
                                ? "Shell execution"
                                : "Provider tool activity"}
                            {typeof event.data.exitCode === "number"
                              ? ` · Exit ${event.data.exitCode}`
                              : ""}
                          </small>
                        </span>
                        <span
                          className={`tool-status ${event.data.status === "completed" ? "complete" : ""}`}
                        >
                          <span className="tool-check">
                            {event.data.status === "completed" ? (
                              <Check size={11} />
                            ) : (
                              <Circle size={10} />
                            )}
                          </span>
                          {statusLabel(String(event.data.status ?? "running"))}
                        </span>
                        {toolDuration(event, events) && (
                          <time className="tool-duration">
                            {toolDuration(event, events)}
                          </time>
                        )}
                      </div>
                    ) : (
                      <div
                        className={`execution-row ${event.type === "execution.failed" ? "failed" : ""}`}
                        key={event.id}
                      >
                        <Circle size={7} />
                        <span>
                          {event.type
                            .slice("execution.".length)
                            .replaceAll("_", " ")}
                          {event.data.message ? ` · ${event.data.message}` : ""}
                        </span>
                      </div>
                    ),
                  )}
                  {running && (
                    <div className="running-row">
                      <span className="pulse-dot" />
                      {agentName} is running
                    </div>
                  )}
                  {latest?.review && (
                    <section className="execution-review">
                      <div className="review-title">
                        <Check size={16} /> Execution result{" "}
                        <Badge variant="outline">{executionStatus}</Badge>
                      </div>
                      <Markdown>{latest.review.summary}</Markdown>
                      <div className="review-checks">
                        {latest.review.checks.map((check) => (
                          <span
                            key={check.name}
                            className={
                              check.status === "passed"
                                ? "check-passed"
                                : "muted"
                            }
                          >
                            {check.name}: {check.status.replaceAll("_", " ")}
                          </span>
                        ))}
                      </div>
                      {detail?.session.taskUrl && (
                        <a
                          href={detail.session.taskUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open Trello task ↗
                        </a>
                      )}
                      <details>
                        <summary>
                          {latest.review.files.length} changed{" "}
                          {latest.review.files.length === 1 ? "file" : "files"}{" "}
                          · View diff
                        </summary>
                        <ul>
                          {latest.review.files.map((file) => (
                            <li key={file}>{file}</li>
                          ))}
                        </ul>
                        <pre>{latest.review.diff || "No file changes."}</pre>
                        {latest.review.truncated && (
                          <p>
                            Preview truncated. Review the worktree for the full
                            change.
                          </p>
                        )}
                      </details>
                      <p className="field-note">
                        Retained worktree: {latest.review.workspace}
                      </p>
                    </section>
                  )}
                  <div ref={bottom} />
                </div>
                {latest?.review?.outcome === "needs_input" && (
                  <div className="decision-request">
                    <strong>Decision needed</strong>
                    <p>{latest.review.question}</p>
                  </div>
                )}
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <Textarea
                    aria-label={
                      selected ? "Execution instruction" : "Work objective"
                    }
                    placeholder={
                      running
                        ? "Execution in progress…"
                        : selected
                          ? `Add an instruction for ${agentName}…`
                          : "Describe the work to execute…"
                    }
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    disabled={
                      busy ||
                      running ||
                      !projectId ||
                      (Boolean(selected) && !detail)
                    }
                    maxLength={32000}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        if (!busy && !running && prompt.trim()) void send();
                      }
                    }}
                  />
                  <div className="composer-footer">
                    <div className="composer-tools">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Open development tasks"
                        title="Development tasks"
                        onClick={() => setView("tasks")}
                      >
                        <Plus size={20} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Project execution settings"
                        title="Execution settings"
                        onClick={() => setShowSettings(true)}
                      >
                        <PanelsTopLeft size={17} />
                      </Button>
                      {latest?.review && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="View execution result"
                          title="Execution result"
                          onClick={() =>
                            document
                              .querySelector(".execution-review")
                              ?.scrollIntoView({
                                block: "center",
                                behavior: "smooth",
                              })
                          }
                        >
                          <FileText size={18} />
                        </Button>
                      )}
                      <span className="composer-policy">
                        {policy === "workspace-write"
                          ? "Worktree"
                          : "Read only"}
                      </span>
                    </div>
                    <span>
                      <Terminal size={13} />
                      {activeProvider === "claude" ? "Claude" : "Codex"}
                      <span className="composer-separator">/</span>
                      {policy === "workspace-write"
                        ? "Worktree editing"
                        : "Read only"}
                    </span>
                    {running ? (
                      <Button
                        type="button"
                        aria-label="Stop execution"
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await request(
                              `/api/sessions/${selected}/cancel`,
                              {},
                            );
                          })
                        }
                      >
                        <Square size={14} fill="currentColor" />
                        <span className="sr-only">Stop</span>
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        type="submit"
                        aria-label={
                          selected ? "Run instruction" : "Run objective"
                        }
                        disabled={
                          busy ||
                          !prompt.trim() ||
                          !projectId ||
                          (Boolean(selected) && !detail)
                        }
                      >
                        <ArrowUp size={19} />
                        <span className="sr-only">Run</span>
                      </Button>
                    )}
                  </div>
                </form>
                <p className="composer-note">
                  {selected
                    ? "Enter to run · Shift + Enter for a new line"
                    : "Draft · Saved only when you run it"}
                </p>
              </>
            )}
          </section>
          {view === "sessions" &&
            showDetails &&
            !showProject &&
            projects.length > 0 && (
              <aside className="details-panel">
                <div className="detail-heading">
                  <span>Session details</span>
                </div>
                <div className="detail-section">
                  <dl>
                    <dt>
                      <SlidersHorizontal size={17} />
                      Status
                    </dt>
                    <dd>
                      <span className={`status-dot ${statusClass}`} />
                      {displayStatus}
                    </dd>
                    <dt>
                      <Timer size={18} />
                      Duration
                    </dt>
                    <dd>{elapsed}</dd>
                    <dt>
                      <ProviderMark provider={activeProvider} size={18} />
                      Provider
                    </dt>
                    <dd className="provider-value">
                      <ProviderMark provider={activeProvider} size={18} />
                      {agentName}
                    </dd>
                    <dt>
                      <Cpu size={17} />
                      Model
                    </dt>
                    <dd className="muted">Unavailable</dd>
                    <dt>
                      <FileText size={17} />
                      Policy
                    </dt>
                    <dd>
                      {policy === "workspace-write" ? "Worktree" : "Read only"}
                    </dd>
                  </dl>
                </div>
                <div className="detail-section" ref={usagePanel}>
                  <h3>Usage</h3>
                  <dl>
                    <dt>
                      <ChartNoAxesColumn size={17} />
                      Input tokens
                    </dt>
                    <dd>{number(usage?.inputTokens)}</dd>
                    <dt>
                      <Database size={17} />
                      Cached input tokens
                    </dt>
                    <dd>{number(usage?.cachedInputTokens)}</dd>
                    <dt>
                      <Coins size={17} />
                      Output tokens
                    </dt>
                    <dd>{number(usage?.outputTokens)}</dd>
                    <dt>
                      <Wrench size={17} />
                      Tool calls
                    </dt>
                    <dd>{toolCalls}</dd>
                    <dt>
                      <Timer size={17} />
                      Subscription quota
                    </dt>
                    <dd className="muted">Unavailable</dd>
                  </dl>
                </div>
                <div className="detail-section activity-section">
                  <h3>Activity</h3>
                  <ol className="activity-timeline">
                    {timeline.map((event) => (
                      <li
                        key={event.id}
                        className={
                          event.type === "execution.started"
                            ? "started"
                            : event.type === "execution.completed" ||
                                event.data.status === "completed"
                              ? "complete"
                              : "attention"
                        }
                      >
                        <span className="timeline-dot">
                          {event.type === "execution.started" ? (
                            <Circle size={8} />
                          ) : (
                            <Check size={9} />
                          )}
                        </span>
                        <span>
                          {event.type === "execution.started"
                            ? "Session started"
                            : event.type === "tool.completed"
                              ? String(event.data.name)
                              : statusLabel(
                                  event.type.slice("execution.".length),
                                )}
                        </span>
                        <time>
                          {new Date(event.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </time>
                      </li>
                    ))}
                    {!timeline.length && (
                      <li className="timeline-empty">
                        Activity appears when execution starts.
                      </li>
                    )}
                  </ol>
                </div>
                <details className="execution-metadata">
                  <summary>Execution metadata</summary>
                  <dl>
                    <dt>Requested model</dt>
                    <dd>
                      {latest?.requestedModel ??
                        project?.model ??
                        "Provider default"}
                    </dd>
                    <dt>Event stream</dt>
                    <dd>
                      {!selected
                        ? "Not started"
                        : connected
                          ? "Connected"
                          : "Reconnecting"}
                    </dd>
                  </dl>
                  <p>Cached input is included in input tokens.</p>
                  <p>{project?.path}</p>
                </details>
              </aside>
            )}
        </div>
      </main>
    </div>
  );
}
