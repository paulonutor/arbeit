import { RequestError } from "./security";
import type { TrelloCard } from "./types";

export interface TaskSource {
  configured: boolean;
  board(ref: string): Promise<{ id: string; name: string }>;
  lists(boardId: string): Promise<{ id: string; name: string }[]>;
  labels(boardId: string): Promise<{ id: string; name: string }[]>;
  cards(listId: string): Promise<TrelloCard[]>;
  card(id: string): Promise<TrelloCard>;
  move(id: string, listId: string): Promise<void>;
  report(id: string, receiptId: string, text: string): Promise<void>;
}
export function trelloId(value: string): string {
  if (!/^[a-f0-9]{24}$/.test(value))
    throw new RequestError("Invalid Trello ID.");
  return value;
}
export class Trello implements TaskSource {
  readonly configured: boolean;
  constructor(
    private key = process.env.ARBEIT_TRELLO_KEY ?? "",
    private token = process.env.ARBEIT_TRELLO_TOKEN ?? "",
    private send: typeof fetch = fetch,
  ) {
    this.configured = Boolean(key && token);
  }
  private async request(
    path: string,
    method = "GET",
    data?: Record<string, string>,
  ): Promise<unknown> {
    if (!this.configured)
      throw new RequestError(
        "Configure ARBEIT_TRELLO_KEY and ARBEIT_TRELLO_TOKEN on the server.",
        503,
      );
    if (!/^[a-zA-Z0-9]+$/.test(this.key) || !/^[a-zA-Z0-9]+$/.test(this.token))
      throw new RequestError("Invalid Trello credentials.", 503);
    let response: Response;
    try {
      response = await this.send(`https://api.trello.com/1/${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"`,
          Accept: "application/json",
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
    } catch {
      throw new RequestError(
        "Trello could not be reached. Dispatch paused.",
        502,
      );
    }
    if (!response.ok)
      throw new RequestError(
        response.status === 429
          ? "Trello rate limit reached. Dispatch paused."
          : "Trello denied the request. Check credentials and board access.",
        502,
      );
    const reader = response.body?.getReader();
    if (!reader)
      throw new RequestError("Trello returned an empty response.", 502);
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new RequestError("Trello response exceeded the limit.", 502);
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError("Trello returned an invalid response.", 502);
    } finally {
      reader.releaseLock();
    }
  }
  async board(ref: string) {
    if (!/^(?:[a-f0-9]{24}|[a-zA-Z0-9]{8})$/.test(ref))
      throw new RequestError("Enter a Trello board URL or ID.");
    return (await this.request(`boards/${ref}?fields=id,name`)) as {
      id: string;
      name: string;
    };
  }
  async lists(boardId: string) {
    return (await this.request(
      `boards/${trelloId(boardId)}/lists?filter=open&fields=id,name`,
    )) as { id: string; name: string }[];
  }
  async labels(boardId: string) {
    return (await this.request(
      `boards/${trelloId(boardId)}/labels?limit=100&fields=id,name`,
    )) as { id: string; name: string }[];
  }
  async cards(listId: string) {
    return (await this.request(
      `lists/${trelloId(listId)}/cards?fields=id,name,desc,url,idBoard,idList,idLabels,closed,pos`,
    )) as TrelloCard[];
  }
  async card(id: string) {
    return (await this.request(
      `cards/${trelloId(id)}?fields=id,name,desc,url,idBoard,idList,idLabels,closed,pos&checklists=all`,
    )) as TrelloCard;
  }
  async move(id: string, listId: string) {
    await this.request(`cards/${trelloId(id)}`, "PUT", {
      idList: trelloId(listId),
    });
  }
  async report(id: string, receiptId: string, text: string) {
    const marker = `Arbeit receipt ${receiptId}`;
    const comments = (await this.request(
      `cards/${trelloId(id)}/actions?filter=commentCard&limit=1000`,
    )) as { data?: { text?: string } }[];
    if (comments.some((comment) => comment.data?.text?.startsWith(marker)))
      return;
    await this.request(`cards/${trelloId(id)}/actions/comments`, "POST", {
      text: `${marker}\n${text}`.slice(0, 12000),
    });
  }
}
export function taskObjective(card: TrelloCard): string {
  const criteria =
    card.checklists?.flatMap((list) =>
      list.checkItems
        .filter((item) => item.state !== "complete")
        .map((item) => `- ${item.name}`),
    ) ?? [];
  const text = `Trello task: ${card.name}\nSource: ${card.url}\n\n${card.desc}\n\nAcceptance criteria:\n${criteria.join("\n") || "Use the card description; request input if success is ambiguous."}`;
  if (text.length > 28000)
    throw new RequestError("Trello task is too large for one execution.");
  return text;
}
