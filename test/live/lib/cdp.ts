/**
 * A minimal CDP client for the live suite over Node's WebSocket, ported from the 2026-10-06 lab (lib.mjs) and the
 * prototype (cdp.mjs). Every command has a timeout (docs/IMPLEMENTATION.md §6.6: 5 s; Extensions.loadUnpacked 10 s).
 */

export type TargetInfo = { targetId: string; type: string; url: string; title: string; attached: boolean };

type Pending = { method: string; resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

type Message = { id?: number; result?: unknown; error?: { message?: string } };

export class Cdp {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.failAll("the CDP socket closed"));
  }

  /** Connects to a browser or page WebSocket URL within `timeoutMs` (3 s by default, §6.6). */
  static connect(url: string, timeoutMs = 3_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`no CDP connection within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new Cdp(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("the CDP connection failed"));
        },
        { once: true },
      );
    });
  }

  /** Sends one command, on the browser session or on `sessionId`, and resolves with its result. */
  send<T = unknown>(method: string, params: object = {}, options: { sessionId?: string; timeoutMs?: number } = {}): Promise<T> {
    const id = ++this.nextId;
    const timeoutMs = options.timeoutMs ?? 5_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timer });
      const message = options.sessionId === undefined ? { id, method, params } : { id, method, params, sessionId: options.sessionId };
      this.socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.socket.close();
  }

  private receive(text: string): void {
    const message = JSON.parse(text) as Message;
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) pending.reject(new Error(`${pending.method}: ${message.error.message ?? "failed"}`));
    else pending.resolve(message.result);
  }

  private failAll(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method}: ${reason}`));
    }
    this.pending.clear();
  }
}

export async function targets(cdp: Cdp): Promise<TargetInfo[]> {
  return (await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets")).targetInfos;
}

/** A flat session on the target. */
export async function attach(cdp: Cdp, targetId: string): Promise<string> {
  return (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
}

/** Evaluates an expression in a session, awaiting a promise result, and returns its value. */
export async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string, timeoutMs = 5_000): Promise<T> {
  const answer = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    { sessionId, timeoutMs },
  );
  if (answer.exceptionDetails !== undefined) {
    throw new Error(`evaluation failed: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "unknown"}`);
  }
  return answer.result.value as T;
}

/** Thrown by a `waitFor` probe when waiting longer cannot help (the process it waits for exited): `waitFor` stops at once. */
export class GiveUp extends Error {}

/**
 * Polls an observed condition until it holds and returns what it saw; a probe that throws counts as not yet, except with
 * `GiveUp`, which fails at once. Fails with the label and the last error after `timeoutMs`. Never a sleep as the success
 * condition: the probe decides.
 */
export async function waitFor<T>(
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  { label, timeoutMs = 15_000, intervalMs = 100 }: { label: string; timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (err) {
      if (err instanceof GiveUp) throw err;
      last = err;
    }
    if (Date.now() >= deadline) {
      const why = last instanceof Error ? `: ${last.message}` : "";
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${why}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
