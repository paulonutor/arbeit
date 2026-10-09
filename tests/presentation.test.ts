import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sessionGroup,
  statusLabel,
  toolDuration,
} from "../src/lib/presentation";
import type { AgentEvent } from "../src/lib/types";

test("session groups use local calendar boundaries without changing persisted dates", () => {
  const now = new Date(2026, 9, 9, 12);
  assert.equal(
    sessionGroup(new Date(2026, 9, 9, 0).toISOString(), now),
    "Today",
  );
  assert.equal(
    sessionGroup(new Date(2026, 9, 8, 23).toISOString(), now),
    "Yesterday",
  );
  assert.equal(
    sessionGroup(new Date(2026, 9, 3, 1).toISOString(), now),
    "This week",
  );
  assert.equal(
    sessionGroup(new Date(2026, 9, 2, 23).toISOString(), now),
    "Earlier",
  );
  assert.equal(statusLabel("timed_out"), "Timed out");
});
test("tool duration requires observed matching lifecycle events in the same execution", () => {
  const start: AgentEvent = {
    version: 1,
    id: 1,
    sessionId: "session",
    executionId: "first",
    timestamp: "2026-10-09T12:00:00.000Z",
    type: "tool.started",
    data: { providerItemId: "tool" },
  };
  const end = {
    ...start,
    id: 2,
    type: "tool.completed",
    timestamp: "2026-10-09T12:00:00.400Z",
  };
  assert.equal(toolDuration(end, [start, end]), "0.4s");
  assert.equal(toolDuration({ ...end, executionId: "other" }, [start]), null);
  assert.equal(toolDuration(end, []), null);
  assert.equal(toolDuration(start, [start]), null);
});
