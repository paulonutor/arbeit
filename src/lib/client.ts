export async function request<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(
    path,
    data === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Request failed.");
  return value;
}
