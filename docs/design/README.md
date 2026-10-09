# Arbeit visual reference

The user supplied [reference.png](reference.png) on 2026-10-09 and requested an exact match where possible. Treat the new image as the visual specification for layout, palette, typography, spacing, borders and controls.

At 1536 × 1024, align the left divider near x=325 and the details divider near x=1255. The application fills the viewport with a borderless, square outer frame, a 314px sidebar, an execution workspace and a 268px details panel. The user requested removal of the reference's decorative traffic lights, outer borders and corner rounding on 2026-10-09. Preserve internal panel dividers. Use near-black neutral surfaces, charcoal gradients, muted gray labels and green completion indicators. Remove the former indigo accents.

Match the standalone Arbeit mark, project selector with path beneath its name, search control and a small secondary New session button at the top of the session list, calendar-grouped session list, Usage and Settings footer, 97px session header with status/provider controls, unboxed user messages, circular agent avatars, 60px tool cards, bordered Markdown results, details icons, real activity timeline and 124px composer.

Reference task names, identities, messages, token counts and timestamps are examples. Render actual saved data. Tool labels and durations must come from recorded provider events. Keep unavailable model/quota values explicit. Composer icons expose working task/settings/result actions; attachment upload and an integrated editor are not implemented.

Preserve transient drafts, execution controls, decisions, review diffs and Trello access. The actions menu opens task execution, session details and project settings. Cmd/Ctrl+K focuses session search; Cmd/Ctrl+N opens a draft. On narrow screens navigation and details become drawers and the composer keeps the full viewport width.

## Validation

Generate and compare desktop and mobile previews against the reference after visual changes. Save temporary previews under `tmp/` and discard them after review. Verify the actual application at desktop and mobile sizes, including menus, search, drawers and draft persistence. Passing tests alone does not establish visual fidelity.

The left sidebar has persistent Dashboard, Tasks and Sessions navigation below the project selector. Dashboard summarizes actual dispatch policy, paused receipts and recent sessions. Tasks displays the configured Trello board with its real lists and cards. The Sessions heading and calendar groups remain visible on every page. Its header has a search icon followed by a plus icon for New session. Search opens a dialog through the icon or Cmd/Ctrl+K; there is no sidebar search input. Main navigation uses the same sizing and icon spacing as the bottom sidebar links. Session details occupy the right rail only in Sessions. An unconfigured Trello connection shows setup guidance instead of sample tasks.

Session details stay docked as a full-height right rail at widths of 1000px and above. Only smaller screens use the overlay.
