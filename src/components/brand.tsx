export function ArbeitMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M15 4c1-2 7-1 6 2L11 28c-1 2-7 2-6-1L15 4Z"
        fill="currentColor"
      />
      <path
        d="m18 20 8-2c3-1 5 2 3 4l-3 3 2 4-6-1-3-4-3 2 2-6Z"
        fill="#a8d2ea"
      />
    </svg>
  );
}
export function CodexMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <path
          key={i}
          transform={`rotate(${i * 60} 12 12)`}
          d="M12 3.2c3.6-2 7.7.6 7.7 4.4 0 2.3-1.2 3.7-3.2 4.8l-4.5 2.6-4.5-2.6V7.2L12 4.6l4.5 2.6v5.2"
        />
      ))}
    </svg>
  );
}
export function ClaudeMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {Array.from({ length: 8 }, (_, i) => (
        <path key={i} transform={`rotate(${i * 45} 12 12)`} d="M12 3.5v6" />
      ))}
    </svg>
  );
}
export function ProviderMark({
  provider,
  size,
}: {
  provider: "codex" | "claude";
  size?: number;
}) {
  return provider === "claude" ? (
    <ClaudeMark size={size} />
  ) : (
    <CodexMark size={size} />
  );
}
export const providerLabel = (provider: "codex" | "claude") =>
  provider === "claude" ? "Claude Code" : "Codex CLI";
