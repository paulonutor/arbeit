# First slice validation

Validated on 2026-10-09 with Node 24.21.0, Next 16.4.0 and Codex 0.149.1.

## Automated checks

- 13 regression tests passed via npm test.
- npm run typecheck passed.
- npm run build passed with webpack.
- git diff --check passed.
- Installed dependencies reported no known vulnerabilities during npm installation.

The suite covers actual-event normalization and privacy filtering, explicit-ID continuation with a read-only policy, durable attempt/history storage, single active attempt, zero exit without provider success, provider errors, malformed/oversized output, missing CLI installation, cancellation and timeout escalation, descendant process cleanup, startup recovery, canonical workspace/symlink checks, hostile origins and scoped SSE disconnect independence.

These tests use local fixture processes; they do not establish native provider support on other systems.

## Real provider and browser flow

Registered the Arbeit repository through the browser, created a session, and sent a read-only prompt containing ARBEIT-LIVE-902. Codex executed cat README.md and emitted command start/completion plus assistant messages. The first attempt completed with exit code 0. A browser refresh retained the full conversation and actual activity. A follow-up asking for the marker used the same provider session ID and returned ARBEIT-LIVE-902. The second attempt also completed with exit code 0.

The database recorded attempt-local usage:

| Attempt      |  Input | Cached input, subset | Output |
| ------------ | -----: | -------------------: | -----: |
| Initial read | 36,569 |               22,272 |    113 |
| Continuation | 18,399 |               18,176 |     11 |

A production-server restart retained both attempts and the conversation. Browser console inspection found no errors. Narrow-screen details and the desktop layout were inspected, including explicit unavailable model/quota values.

## Limits

Live cancellation/recovery was tested during Phase 0; application cancellation, process-tree cleanup and timeout were exercised through regression fixtures. The browser Stop button is wired to that tested API. No live editing, native decisions, artifact serving, Claude adapter or quota adapter is implemented in this slice. Missing terminal output is a failed attempt, not success.

Turbopack's worker socket was blocked by this development environment, including a host-access build attempt. The supported webpack build succeeded. This is a build environment finding, not a provider capability limitation.

## Hono refactor and execution drafts

The current application uses Hono 4.13.13, @hono/node-server 2.1.4, Vite 8.3.4 and Node 24.21.0. Next.js and its source/configuration entry points were removed. Production and Vite middleware development servers both started on localhost.

All 16 regression tests pass, including transient drafts, atomic first-execution persistence and rollback, invalid/oversized creation commands, hostile hosts and missing mutation origins, SSE replay and browser-disconnect independence. Typecheck, ESLint, Prettier and the Vite production build pass.

Live browser verification retained all existing history. Clicking New session and entering an objective left the persisted session count at three. Run created the fourth session and its first attempt. A real read-only Codex execution inspected package.json, emitted actual tool activity and completed successfully with reported usage. No synthetic tool or progress data was introduced.

Final visual checks covered 1536 × 1024 desktop and 375 × 812 mobile. The mobile composer spans x=13 to x=362, document width remains 375px, and both navigation and session details can be opened and closed. Session search was exercised with package.json and restored. Vite development middleware served the onboarding screen correctly; its browser console reported no errors. Updated desktop and mobile previews are saved in docs/design.

## Controlled editing and automatic task execution

The current Hono application passes 26 regression tests, typecheck, ESLint, Prettier and the Vite production build. New coverage verifies clean-source requirements, worktree isolation and reuse, revoked editing policy, actual check evidence, typed questions, sequential labelled-card dispatch, durable uncertain claims, restart pause, pause during a pending Trello read, secret-header transport and workflow/origin validation. Trello tests use a fixture source and mocked REST responses; they do not establish live account access.

A bounded real Codex execution completed in session 6746b2b8-5ec1-49e9-bf44-3d5a0a9d1cde. It changed only greeting.txt in the isolated worktree, emitted an actual completed npm test command with exit zero and returned ready_for_review. The source fixture still contained todo. The retained Editing validation project exposes the real diff and check result in the UI. No main-repository commit or automatic merge was performed.

No Trello credentials were configured locally during validation. Live REST access and unattended execution against a real card remain unverified until those credentials are supplied. Existing sessions were preserved by additive SQLite migrations.

Final browser verification covered the policy dialog, Trello setup state, persisted real execution, Markdown summary, diff disclosure and 1536 × 1024 / 375 × 812 layouts. Mobile document width remained 375px.

## New visual reference

The user replaced the reference on 2026-10-09 and requested a close match. The rebuilt interface uses neutral charcoal surfaces, green completion states, a full-width project selector, calendar session groups, a status/provider header, real tool durations, an activity timeline, a taller composer and narrow-screen drawers. At 1536 × 1024 the conversation begins at x=326, details at x=1256, and the composer measures 898 × 124. The reference dividers are near x=325 and x=1255.

Visual checks covered desktop and 375 × 812 mobile, search, project switching, task actions, settings, navigation/details drawers and the real saved package.json execution. Mobile document width remained 375px. Opening a draft and typing an objective left the session count at five. No provider execution was started during design validation.

All 28 tests pass, including calendar grouping, observed tool duration and latest persisted status coverage. Typecheck, ESLint, formatting and the Vite build pass. The production build emits a non-failing bundle-size advisory.
