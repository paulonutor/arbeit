export type Status =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";
export interface Project {
  id: string;
  name: string;
  path: string;
  model: string | null;
  mode: Mode;
  checks: string[];
  workflow: WorkflowConfig | null;
}
export interface Session {
  id: string;
  projectId: string;
  title: string;
  provider: "codex";
  providerSessionId: string | null;
  createdAt: string;
  mode: Mode;
  workspace: string | null;
  baseCommit: string | null;
  taskUrl: string | null;
  latestStatus?: Status | null;
}
export interface Execution {
  id: string;
  sessionId: string;
  requestedModel: string | null;
  status: Status;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  review: Review | null;
}
export interface AgentEvent {
  version: 1;
  id: number;
  sessionId: string;
  executionId: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}
export interface SessionDetail {
  session: Session;
  project: Project;
  executions: Execution[];
  events: AgentEvent[];
}

export type Mode = "read-only" | "workspace-write";
export interface WorkflowConfig {
  boardId: string;
  readyListId: string;
  runningListId: string;
  reviewListId: string;
  labelId: string;
  enabled: boolean;
  remaining: number;
  reason: string | null;
}
export interface CheckResult {
  name: string;
  status: "passed" | "failed" | "not_run";
  exitCode: number | null;
}
export interface Review {
  outcome: "ready_for_review" | "needs_input" | "blocked";
  summary: string;
  question: string | null;
  checks: CheckResult[];
  diff: string;
  files: string[];
  workspace: string | null;
  baseCommit: string | null;
  truncated: boolean;
}
export interface TaskReceipt {
  id: string;
  projectId: string;
  cardId: string;
  cardUrl: string;
  sessionId: string | null;
  status: "claimed" | "running" | "reported" | "paused";
  message: string | null;
  createdAt: string;
}
export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  url: string;
  idBoard: string;
  idList: string;
  idLabels: string[];
  closed: boolean;
  pos: number;
  checklists?: {
    name: string;
    checkItems: { name: string; state: string }[];
  }[];
}
