# Arbeit — Initial Codex Desktop Prompt

You are starting development of a new project called **Arbeit**.

Arbeit is a local-first, web-based orchestration platform for
coding agents, initially targeting Codex CLI and Claude Code CLI.

Read `ARBEIT_PLAN.md` before making architectural decisions.

## Your first objective

Do not immediately implement the complete application.

Start with Phase 0: Provider Capability Research.

Investigate the real capabilities of Codex CLI and Claude Code CLI.

Pay particular attention to:

- Structured JSON output
- Streaming events
- Tool invocation events
- MCP tool visibility
- Session creation and continuation
- Token usage reporting
- Model information
- Subscription quota availability
- Interactive input handling
- Process cancellation
- Recovery after process termination

Inspect official documentation and available CLI commands.

Where possible, execute representative commands and inspect
their actual output.

Clearly distinguish verified functionality from assumptions.

Never fabricate provider capabilities.

## Architecture

After the research phase:

1. Document the findings.
2. Propose the simplest viable architecture.
3. Define a provider-independent agent event protocol.
4. Identify unsupported features and required fallbacks.
5. Define the initial domain model.
6. Implement the smallest functional vertical slice.

Prefer:

- Next.js
- TypeScript
- React
- Tailwind CSS
- shadcn/ui
- SQLite
- SSE for streaming

A separate worker process may be introduced where necessary.

Avoid unnecessary services and abstractions.

## UI requirements

Create a minimal, polished dark-mode Agent Control Center.

The conversation is the primary workspace.

Use compact navigation and avoid unnecessary tabs.

The interface should display:

- Sessions
- Agent messages
- Actual tool activity
- Interactive decisions
- Artifacts
- Available usage information

Do not implement an integrated code editor.

Use shadcn/ui components consistently.

Reuse components instead of introducing redundant custom controls.

Establish shared design tokens and consistent UI patterns.

## Agent behavior

Agents should work autonomously when requirements are clear.

When a meaningful decision requires user input,
request that input explicitly.

Support visual previews when useful, but do not generate
unnecessary alternatives.

Preserve session context wherever technically possible.

## Security

The initial application runs locally or through Docker.

Do not expose unauthenticated execution endpoints publicly.

Default to localhost-only access.

Do not grant unnecessary host or Docker privileges.

Do not expose credentials through logs or generated artifacts.

## Trello

Trello is the single source of truth for all project tasks,
ideas, bugs, and development progress.

Create or update `AGENTS.md` with this rule.

Always check Trello before starting implementation work.

Use existing cards whenever possible.

Create new cards when work is not already represented.

Update task status and progress throughout development.

Use the available Trello MCP integration.

Do not create a competing task backlog in the repository.

Trello integration inside Arbeit itself is not required
for the initial MVP.

## Implementation approach

Work incrementally.

Do not implement future phases prematurely.

Prioritize working integrations over speculative features.

Keep the architecture extensible without overengineering it.

Document important decisions and their rationale.

## Expected first deliverables

1. Provider capability matrix
2. Architecture proposal
3. Agent protocol specification
4. Initial domain model
5. Updated AGENTS.md
6. Trello tasks for the implementation
7. First working vertical slice, if research confirms feasibility

Begin with the provider capability investigation.

Report any important technical limitations before
committing to an architecture that depends on them.
