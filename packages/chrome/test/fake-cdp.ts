import type { CdpTransport } from "../src/index.ts";

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * An in-memory CDP browser endpoint (docs/IMPLEMENTATION.md §3: the CDP role adapters are tested against one). Each
 * method answers with its handler's result, or with a CDP error when the handler throws; a method without a handler
 * never answers. Every command is recorded.
 */
export class FakeCdp implements CdpTransport {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  readonly handlers = new Map<string, Handler>();
  private listener: (text: string) => void = () => undefined;
  private closeListener: () => void = () => undefined;
  closed = false;

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  send(text: string): void {
    const message = JSON.parse(text) as { id: number; method: string; params?: Record<string, unknown> };
    const params = message.params ?? {};
    this.sent.push({ method: message.method, params });
    const handler = this.handlers.get(message.method);
    if (handler === undefined) return;
    queueMicrotask(() => {
      try {
        const result = handler(params);
        this.listener(JSON.stringify({ id: message.id, result }));
      } catch (err) {
        this.listener(JSON.stringify({ id: message.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }));
      }
    });
  }

  onMessage(listener: (text: string) => void): void {
    this.listener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  close(): void {
    this.closed = true;
    this.closeListener();
  }

  /** Chrome sends `text` unasked (an event, or an answer to nothing). */
  emit(text: string): void {
    this.listener(text);
  }

  /** The commands sent, by method, in order. */
  methods(): string[] {
    return this.sent.map((entry) => entry.method);
  }
}
