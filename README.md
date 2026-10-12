# Arbeit

A local automatic development system with Hono, React/Vite and SQLite. Codex CLI or Claude Code executes objectives in isolated Git worktrees; Trello supplies eligible tasks. The interface shows actual activity, checks, diffs and decisions.

## Run locally

Requires Node.js 24 or later and at least one coding agent CLI: Codex CLI (tested 0.149.1) or Claude Code (tested 2.1.296). Project settings lists both agents with their install and sign-in state. Install runs `npm install` for the official package into `.arbeit/providers`, never globally and never through a shell, and Sign in starts the provider's own login (`codex login`, `claude auth login`) and shows the sign-in page it prints. Arbeit never receives or stores credentials; `ANTHROPIC_API_KEY` and similar variables in the server environment are passed through to the CLI. An existing install on `PATH` is used first. Automatic install is not available on Windows. Choose the agent per project; each session keeps the agent that started it.

```sh
npm ci
npm run dev
```

Open [Arbeit](http://127.0.0.1:3000). Choose or add a project beside the logo. New session stays a browser draft until Run starts its first execution. Stop cancels the active process. History and explicit provider continuation survive browser refreshes.

For production:

```sh
npm run build
npm start
```

`ARBEIT_WORKSPACE_ROOT` selects the allowed project root (default: server working directory). `ARBEIT_DATA_DIR` selects storage (default: `.arbeit`). `PORT` defaults to 3000. The server binds to 127.0.0.1 and requires same-origin mutations.

## Controlled editing

Open Project settings from the project selector. Opt into isolated editing and select required npm checks. Editing requires a clean Git repository with a committed HEAD. Each new editing session gets a retained `codex/arbeit-…` branch and worktree under `.arbeit/worktrees`. Existing read-only sessions retain their policy; start a new session after opting in.

Codex runs with workspace-write sandbox, network access disabled and approval policy `never`. Claude Code runs with `--permission-mode dontAsk` and an explicit allow list: Read, Grep and Glob when read-only; additionally Edit, Write and Bash restricted to the exact required check commands when editing. Anything else is denied, not prompted. Claude's Bash tool is not wrapped in an OS sandbox by Arbeit, so the allow list is the boundary. Work outside that policy cannot receive automatic permission. Arbeit records the real diff and completed check commands. A schema-constrained result distinguishes ready for review, blocked and needs input. Answer a question with another execution in the same session.

Changes remain in the worktree for review. Arbeit does not merge or push them. Required checks must actually complete successfully before a task becomes ready for review. The checkout and installed tools are trusted; inspect the diff, including changes to tests and scripts.

## Trello execution

The running application needs its own Trello API credentials. This chat's connector credentials are not transferable. Copy `.env.example` to `.env`, configure `ARBEIT_TRELLO_KEY` and `ARBEIT_TRELLO_TOKEN`, then restart. Keep `.env` private; it is ignored by Git. See [Trello authentication](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/).

In Project settings, load the real board, select distinct ready/running/review lists, and select an eligibility label. Only open cards in the ready list with that label can run. Their description and incomplete checklist items form the objective. Tasks opens the live queue; Run starts one card, or Arm batch authorizes 1–10 sequential executions independently of the browser.

Arbeit claims each card durably before moving it to running. Successful verified results are summarized on the card and moved to review. Failures, questions, uncertain Trello writes and server restarts pause dispatch. Resolve the retained receipt before rearming; interrupted work is never automatically replayed. Pause prevents further dispatch; use Stop to cancel active execution. Separate task worktrees start from the source HEAD, so dependent tasks require reviewed changes to be incorporated before they run.

Trello remains the source of task truth. Local receipts track execution and prevent duplicate dispatch; they are not a second backlog.

## Validation and limits

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Tests cover persistence, continuation, cancellation, timeouts, origin/path guards, SSE, isolated edits, structured decisions, sequential dispatch and uncertain claims. A real Codex editing run changed a worktree, passed its required test and left its source untouched. See [validation](docs/validation.md).

Trello REST transport and dispatch are fixture-tested. Live unattended Trello access awaits local credentials. Claude execution, native mid-turn permission hosting, account quotas, general artifact serving and Docker deployment remain separate integrations. Tool summaries omit arguments/output; reasoning is filtered before persistence. User messages, summaries and diffs are stored locally, so keep `.arbeit` private.

## Records

- [Architecture](docs/architecture.md)
- [Provider capabilities](docs/provider-capabilities.md)
- [Agent event protocol](docs/agent-protocol.md)
- [Arbeit Trello board](https://trello.com/b/vk9KaAnK/arbeit)

Trello is the source of truth for development tasks, ideas, bugs and progress. Repository documents contain specifications and evidence.
