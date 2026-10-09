# Arbeit agent instructions

Read ARBEIT_PLAN.md and docs/provider-capabilities.md before changing provider behavior.

## Task management

Trello is the single source of truth for all development tasks, ideas, bugs and progress.
Use the available Trello MCP integration and the [Arbeit board](https://trello.com/b/vk9KaAnK/arbeit).
Check existing cards before starting work. Reuse cards, avoid duplicates, and create a card when work is not represented.
Move cards and record progress as work advances. Keep implementation and validation evidence synchronized with the card.
If Trello is unavailable, report the limitation and retry before starting implementation.
Do not maintain a competing task backlog in this repository. Technical specifications and architecture records belong in docs.

## Implementation

Prefer simple explicit TypeScript, Hono on Node.js, Vite, React, Tailwind, shadcn/ui and SQLite.
Keep execution independent of browser connections. Separate sessions from execution attempts.
Use actual provider events. Never infer tool activity from message text, expose reasoning, or fabricate usage or progress.
Missing provider data is null, not zero. Store requested and reported models separately.
Bind to localhost. Validate request origins and registered workspace paths. Spawn argument arrays without a shell.
Do not disable provider sandboxes or permission checks. Do not store credentials or full unfiltered provider output in logs.
Add meaningful tests when behavior changes. Use npm test, npm run typecheck, npm run lint, npm run format:check and npm run build.
Use ESLint and Prettier; keep their checks clean.
Arbeit is an autonomous coding-agent orchestration system. The interface supplies objectives, observes execution and handles decisions. Avoid shaping it into a generic chat harness.
New sessions are browser drafts until the first execution. Persist the session, first attempt and initial events atomically after validating the execution command.

Editing requires an explicit project policy, a clean committed source, an isolated worktree and observed required checks. Keep changes reviewable; do not merge or push automatically. Use the enforced result schema for decisions, never freeform permission parsing. Trello claims must be durable before external writes; pause on uncertainty or restart rather than replaying work.

## Visual design

Use docs/design/reference.png and docs/design/README.md for UI changes. Match the latest reference as closely as possible, including its neutral dark palette, typography, spacing and layout proportions. Validate desktop and narrow layouts visually; passing behavior tests does not establish visual fidelity.
