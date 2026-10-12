# Arbeit — Coding Agent Orchestrator

## 1. Vision

Arbeit is a local-first, web-based orchestration platform for coding agents.

It provides a unified interface for managing coding sessions,
interacting with agents, tracking usage, and coordinating development tasks.

The goal is to improve development efficiency while minimizing unnecessary
token consumption and preserving the capabilities of existing coding agents.

### Core principles

- Autonomous by default, interactive when necessary.
- Optimize token usage without sacrificing quality.
- Support multiple coding agent providers.
- Preserve native agent capabilities.
- Keep the interface minimal and consistent.
- Make agent execution observable without exposing internal reasoning.
- Support local execution, Docker, and eventually remote hosting.
- Trello is the source of truth for project management.
- Do not implement features based on assumed provider capabilities.

## 2. Technology Stack

Preferred starting point (the first slice used Next.js; the project moved to
Hono and Vite, see `docs/architecture.md`):

| Component | Technology |
|---|---|
| Application | Hono on Node.js + TypeScript |
| UI | React + Vite |
| Styling | Tailwind CSS |
| Components | shadcn/ui |
| Persistence | SQLite |
| Streaming | SSE |
| Agent execution | Node.js child processes |
| Deployment | Local / Docker |
| Mobile | Responsive web application / PWA |

### Architecture

Start with a modular monolith.

Separate these responsibilities:

- Web interface
- Application API
- Agent orchestration
- Agent provider adapters
- Session management
- Interaction management
- Usage tracking
- Task management
- Artifact management
- Notifications

Avoid premature microservices.

Agent execution must remain separate from the UI lifecycle.

Long-running executions must not depend on an active browser connection.

## 3. Phase 0 — Provider Capability Research

**This phase is mandatory and must be completed before implementing
the main orchestration architecture.**

Investigate the actual capabilities of:

- OpenAI Codex CLI
- Anthropic Claude Code CLI

Focus specifically on:

- `codex exec`
- Codex structured output and session continuation
- `claude -p` / print mode
- Claude structured output and session continuation

### Research questions

Determine whether each provider supports:

1. Starting a session programmatically.
2. Resuming an existing session.
3. Streaming structured output.
4. Reporting tool invocations.
5. Reporting tool completion and errors.
6. Identifying tools such as MCP, shell, and browser tools.
7. Reporting token usage.
8. Reporting model information.
9. Reporting context-window consumption.
10. Reporting remaining subscription quotas.
11. Changing models between executions.
12. Handling interactive questions.
13. Interrupting or cancelling execution.
14. Recovering after process termination.
15. Running multiple sessions concurrently.
16. Producing and exposing artifacts.

### Deliverables

Create:

- `docs/provider-capabilities.md`
- `docs/architecture.md`
- `docs/agent-protocol.md`

The capability matrix must distinguish:

- Confirmed and tested
- Documented but not tested
- Unsupported
- Unknown

Include references to official documentation and actual CLI output.

Never invent capabilities.

If a capability is unavailable, design an explicit fallback.

### Acceptance criteria

- Both CLIs have been investigated.
- Representative commands have been executed where possible.
- Actual structured events have been inspected.
- Session continuation has been evaluated.
- Usage availability has been verified.
- Architecture decisions are based on findings.

Do not proceed with speculative implementations.

## 4. Phase 1 — Core MVP

### Goal

Control coding agents through a web interface.

### Features

#### Projects

- Create and select projects.
- Associate projects with local repository paths.
- Configure the preferred agent provider.
- Configure the preferred model.
- Store project-specific settings.

#### Sessions

- Start sessions.
- Send messages.
- Receive streaming output.
- Display structured agent events.
- Stop running executions.
- Resume sessions when supported.
- Persist conversation history.
- Display execution errors.

#### Activity

Show concise information such as:

- Reading files
- Editing files
- Executing commands
- Calling MCP tools
- Generating artifacts
- Waiting for user input

Only show activities supported by actual provider data.

Do not fabricate progress percentages or agent states.

#### Usage

Capture available information:

- Provider
- Model
- Input tokens
- Output tokens
- Cached tokens
- Execution duration
- Session-level usage

Missing data must be represented explicitly.

#### Execution

- Execute agents through provider adapters.
- Keep sessions independent of browser connections.
- Support cancellation.
- Persist execution state.
- Handle process failures.
- Maintain structured execution logs.

### Acceptance criteria

A user can select a project, start a Codex session,
send messages, inspect actual agent activity,
and review available usage data.

The session remains visible after refreshing the browser.

## 5. Phase 2 — Interactive Decisions and Artifacts

### Goal

Allow agents to request user input without losing session context.

### Interaction model

Agents should work autonomously when decisions are straightforward.

When meaningful ambiguity exists, they should request user input.

Supported interactions:

- Free-text questions
- Single-choice decisions
- Multiple-choice decisions
- Optional comments
- Visual alternatives

Decisions are presented individually and immediately.

### Interaction lifecycle

1. Agent identifies a decision.
2. Orchestrator records the interaction.
3. Session enters a waiting state.
4. User receives the question.
5. User submits an answer.
6. Orchestrator resumes execution.

Where native provider suspension is unavailable,
implement a compatible execution-boundary strategy.

Do not assume arbitrary CLI processes can be paused and resumed.

### Artifacts

Support:

- Generated images
- Screenshots
- Playwright screenshots
- Self-contained HTML previews

HTML previews must:

- Run in sandboxed iframes.
- Be isolated from the application origin.
- Have no access to credentials.
- Have no unrestricted network or host access.

Previews are created only when useful.

Do not automatically generate multiple alternatives for every task.

### Execution modes

- Autonomous
- Interactive
- Direct conversation

Users should be able to influence the execution mode.

### Acceptance criteria

A user can receive a decision request, inspect visual alternatives,
select an option, and continue the associated agent workflow.

## 6. Phase 3 — Usage and Optimization

### Goal

Reduce unnecessary token consumption and improve model selection.

### Usage dashboard

Provide usage breakdowns by:

- Provider
- Model
- Project
- Session
- Task
- Time period

Distinguish between:

- Actual token usage
- Estimated API costs
- Subscription quota information

Subscription limits must not be represented as API costs.

Quota information is shown only when reliably available.

### Model routing

Introduce configurable model-selection policies.

Examples:

- Simple edits: lower-cost model
- Documentation: lower-cost model
- UI design: balanced model
- Architecture: stronger model
- Complex debugging: stronger model

Start with deterministic rules.

LLM-based classification is optional.

### Session optimization

- Detect possible topic changes.
- Recommend splitting unrelated tasks.
- Generate concise session handoffs.
- Reduce unnecessary context duplication.
- Detect excessive context growth where measurable.
- Recommend model escalation after repeated failures.

Do not automatically create expensive parallel executions.

### Supervisor

The supervisor coordinates execution without coding itself.

Responsibilities:

- Task classification
- Provider selection
- Model selection
- Session lifecycle
- Usage monitoring
- Decision policies
- Failure handling
- Context handoffs

Prefer event-driven and deterministic logic.

Use LLM calls only when semantic interpretation is necessary.

## 7. Phase 4 — Trello Integration

### Goal

Connect project tasks with coding sessions.

Trello remains the source of truth for tasks, ideas, bugs,
and development progress.

### Task sources

Tasks may originate from:

- Trello integration in Arbeit
- Existing Trello MCP tools used by coding agents
- Manually initiated sessions

Avoid coupling the core agent runtime to Trello.

### Initial integration

- Associate sessions with Trello cards.
- Store external task references.
- Allow agents to create and update cards through MCP.
- Preserve links between tasks and sessions.

### Later: Kanban

- Select Trello boards.
- Display cards grouped by Trello lists.
- Move cards between lists.
- Display linked agent sessions.
- Display agent execution status.

Do not implement a complete Trello replacement.

### Task granularity

Prefer separate cards for distinct work:

- Design
- Implementation
- Testing

Do not create all phases automatically for every feature.

Agents may create new cards when necessary.

Newly created cards must not automatically trigger execution.

## 8. Phase 5 — Mobile and Notifications

### Goal

Allow users to manage running agents remotely.

### Features

- Responsive mobile interface
- PWA support
- Web Push notifications
- Decision notifications
- Completion notifications
- Error notifications
- Mobile chat
- Mobile artifact previews

### Session lifecycle

Support states such as:

- Created
- Running
- Waiting for input
- Completed
- Failed
- Cancelled
- Timed out

### Timeouts

Support configurable limits:

- Maximum execution duration
- Maximum waiting duration
- Maximum retries
- Maximum permitted usage

Waiting for a user must not require an indefinitely running
CLI process when the provider supports resumable execution.

Persist interaction state across application restarts.

## 9. Phase 6 — Advanced Orchestration

### Features

- Additional agent providers
- Parallel sessions
- Sub-agent orchestration
- Dependency-aware task execution
- Dynamic model routing
- Budget policies
- Remote workers
- Optional hosted deployment

### Parallel execution

Use parallel agents only when tasks are sufficiently independent.

Prefer separate Git worktrees to avoid workspace conflicts.

Do not introduce multi-agent execution merely for its own sake.

## 10. UI/UX Design

### Direction

Minimal dark-mode Agent Control Center.

Inspired by polished developer tools such as Linear,
but without unnecessary dashboard complexity.

### Main interface

The session conversation is the primary workspace.

Navigation should provide access to:

- Projects
- Sessions
- Decisions
- Usage
- Settings

Avoid excessive navigation tabs.

Use compact filtering instead of duplicating navigation.

### Session sidebar

Keep it minimal.

Display:

- Session title
- Project
- Agent/provider
- Compact status indicator

Avoid excessive metadata and visual clutter.

### Main conversation

Display:

- User messages
- Agent messages
- Relevant tool activity
- Decisions
- Artifacts

Do not display internal chain-of-thought.

### Details panel

Optional contextual panel showing:

- Current execution status
- Model
- Usage
- Duration
- Recent tool activity

Display only verified information.

### Component requirements

Use Tailwind CSS and shadcn/ui.

Reuse existing components whenever possible.

Prefer shared components and design tokens.

Do not create custom UI components when an appropriate
shadcn/ui component already exists.

Maintain consistent:

- Spacing
- Typography
- Colors
- Borders
- Interaction patterns
- Loading states
- Empty states

Avoid generic AI-generated dashboard aesthetics.

## 11. Security

### Local-first

The application must be secure by default.

Requirements:

- Bind to localhost by default.
- Never expose unauthenticated APIs publicly.
- Protect local execution endpoints.
- Restrict workspace access.
- Avoid logging credentials.
- Isolate generated HTML.
- Validate filesystem paths.
- Protect against command injection.
- Avoid unrestricted container privileges.

### Docker

Support Docker deployment without granting unnecessary
host privileges.

Do not expose the Docker socket by default.

Use a separate host worker if required for CLI execution.

### Future hosting

Authentication is not required for the initial localhost MVP.

Before remote exposure, implement:

- Authentication
- Authorization
- TLS
- Secure worker communication
- Credential isolation

Do not assume that running inside Docker provides sufficient security.

## 12. Domain Model

Suggested entities:

- Project
- TaskReference
- Session
- Execution
- AgentProvider
- AgentEvent
- Interaction
- Artifact
- UsageRecord
- ExecutionPolicy
- Worker

Keep the model small and extensible.

Separate a logical session from individual execution attempts.

Persist important lifecycle transitions.

## 13. Explicit Non-Goals

The initial product does not need:

- Integrated code editor
- Full IDE
- Complete project management system
- Kanban board in the MVP
- Automated testing pipelines
- Automatic deployment
- Multi-user support
- Cloud hosting
- Full application preview environments
- Continuous LLM-based supervision

## 14. Development Strategy

Implement incremental vertical slices.

Recommended sequence:

1. Provider capability research
2. Agent protocol definition
3. Minimal execution adapter
4. Session persistence
5. Streaming web interface
6. Actual activity events
7. Basic usage tracking
8. Interactive decisions
9. Artifact rendering
10. Usage optimization
11. Trello integration
12. Mobile notifications
13. Advanced orchestration

Validate the hardest integration assumptions early.

Avoid implementing speculative abstractions.

## 15. Project Management

Trello is the single source of truth for all project tasks,
ideas, bugs, and development progress.

The repository must contain an `AGENTS.md` file documenting:

- Trello is mandatory for task management.
- Check existing cards before starting work.
- Update card status as work progresses.
- Create cards when necessary.
- Avoid duplicate tasks.
- Keep development progress synchronized.
- Use the available Trello MCP integration.
- Do not maintain a competing repository backlog.

Architecture documentation and technical specifications
may remain in the repository.

The Trello board tracks their implementation.
