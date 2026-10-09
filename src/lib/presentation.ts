import type { AgentEvent } from "./types";

export function statusLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
export function sessionGroup(timestamp: string, now = new Date()) {
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  if (date >= today) return "Today";
  if (date >= yesterday) return "Yesterday";
  if (date >= week) return "This week";
  return "Earlier";
}
export function toolDuration(event: AgentEvent, events: AgentEvent[]) {
  const start = events.find(
    (candidate) =>
      candidate.type === "tool.started" &&
      candidate.executionId === event.executionId &&
      candidate.data.providerItemId === event.data.providerItemId,
  );
  if (!start || event.type !== "tool.completed") return null;
  const ms = Date.parse(event.timestamp) - Date.parse(start.timestamp);
  return ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : null;
}
