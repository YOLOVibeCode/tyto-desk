/** How a CDP connection moves text: Node's WebSocket in production, an in-memory endpoint in tests. */
export interface CdpTransport {
  send(text: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/**
 * - `error`: Chrome answered with a CDP error (its text is not kept: it can quote the request).
 * - `timeout`: no answer within the command's budget.
 * - `closed`: the connection ended first.
 */
export type CdpResult = { ok: true; result: Record<string, unknown> } | { ok: false; reason: "error" | "timeout" | "closed" };

type Pending = { resolve: (result: CdpResult) => void; timer: NodeJS.Timeout };

/** A CDP command's budget (docs/IMPLEMENTATION.md §6.6); callers give Extensions.loadUnpacked 10 s. */
export const CDP_COMMAND_MS = 5_000;

/**
 * One CDP session on the browser target (docs/IMPLEMENTATION.md §2, packages/chrome): commands with ids and budgets,
 * answers matched by id. Events are ignored: slice 1c's role adapters only ask. Desk never attaches to its own
 * extension targets.
 */
export class CdpConnection {
  private readonly transport: CdpTransport;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;

  constructor(transport: CdpTransport) {
    this.transport = transport;
    transport.onMessage((text) => this.receive(text));
    transport.onClose(() => this.end());
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = CDP_COMMAND_MS): Promise<CdpResult> {
    if (this.closed) return Promise.resolve({ ok: false, reason: "closed" });
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.transport.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.transport.close();
    this.end();
  }

  private receive(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || !("id" in message) || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    const result = "result" in message && typeof message.result === "object" && message.result !== null ? message.result : null;
    pending.resolve(result === null ? { ok: false, reason: "error" } : { ok: true, result: result as Record<string, unknown> });
  }

  private end(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: "closed" });
    }
    this.pending.clear();
  }
}

/** Opens Node's WebSocket client on a browser WebSocket URL within `timeoutMs` (§6.6: 3 s), or `null`. */
export function openWebSocket(url: string, timeoutMs = 3_000): Promise<CdpTransport | null> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, timeoutMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve({
          send: (text) => socket.send(text),
          onMessage: (listener) => socket.addEventListener("message", (event) => listener(String(event.data))),
          onClose: (listener) => socket.addEventListener("close", () => listener()),
          close: () => socket.close(),
        });
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { once: true },
    );
  });
}
