import type { HiddenTargets } from "@desk/core";
import { WebSocket } from "ws";
import { rawRequest } from "./raw-http.ts";

/** §6.4: the watch's Chrome probe backs off from 100 ms to 5 s. */
const RETRY_CAP_MS = 5_000;

/**
 * The guarded endpoint's own connection to the Desk Chrome (§12): `Target.setDiscoverTargets` makes Chrome report every
 * target as it is created, changed and destroyed, which keeps `HiddenTargets` complete before any client can name a
 * target. `up` is true from Chrome's answer to that command, after the existing targets were reported, until the
 * connection drops; then it reconnects with backoff, following Chrome across restarts and updates.
 */
export class TargetFeed {
  up = false;
  private readonly rawPort: number;
  private readonly hidden: HiddenTargets;
  private readonly firstRetryMs: number;
  private retryMs: number;
  private socket: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(input: { rawPort: number; hidden: HiddenTargets; firstRetryMs?: number }) {
    this.rawPort = input.rawPort;
    this.hidden = input.hidden;
    this.firstRetryMs = input.firstRetryMs ?? 100;
    this.retryMs = this.firstRetryMs;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.up = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.terminate();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const version = await rawRequest(this.rawPort, "GET", "/json/version");
    const url = version?.status === 200 ? this.browserUrl(version.body) : null;
    if (url === null || this.stopped) {
      this.retry();
      return;
    }
    const socket = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 3_000 });
    this.socket = socket;
    socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } })));
    socket.on("message", (data) => this.receive(String(data)));
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.up = false;
      this.retry();
    });
  }

  private receive(text: string): void {
    let message: { id?: unknown; method?: unknown; params?: { targetInfo?: { targetId?: unknown; url?: unknown }; targetId?: unknown } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.id === 1) {
      this.up = true;
      this.retryMs = this.firstRetryMs;
      return;
    }
    const info = message.params?.targetInfo;
    if ((message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") && typeof info?.targetId === "string" && typeof info.url === "string") {
      this.hidden.observe({ targetId: info.targetId, url: info.url });
    } else if (message.method === "Target.targetDestroyed" && typeof message.params?.targetId === "string") {
      this.hidden.forget(message.params.targetId);
    }
  }

  private retry(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_CAP_MS);
  }

  /** Chrome's browser WebSocket from `/json/version`, only on 127.0.0.1 at the raw port. */
  private browserUrl(body: Buffer): string | null {
    try {
      const url = (JSON.parse(body.toString("utf8")) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
      if (typeof url !== "string") return null;
      const parsed = new URL(url);
      return parsed.protocol === "ws:" && parsed.hostname === "127.0.0.1" && Number(parsed.port) === this.rawPort ? url : null;
    } catch {
      return null;
    }
  }
}
