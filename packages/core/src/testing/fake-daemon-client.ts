import type { DaemonClient, DaemonNotice, DaemonOpen, DaemonRequest } from "../ports/daemon-client.ts";
import type { DaemonMessage, PaneListEntry } from "../protocol/messages.ts";

/**
 * A daemon the test scripts: unreachable until `reachable` is set; `list` reports `swConnected` and `panels`, and an
 * extension call answers with `extAnswer`. Requests are recorded.
 */
export class FakeDaemonClient implements DaemonClient {
  reachable: boolean;
  swConnected = false;
  swConnects = 0;
  panels: number[] = [];
  paneList: PaneListEntry[] = [];
  gatewayClients = 0;
  paused = false;
  readonly requests: DaemonRequest[] = [];
  readonly notices: DaemonNotice[] = [];
  extAnswer: (request: DaemonRequest) => DaemonMessage = () => ({ type: "error", code: "E_NOEXT", message: "the Desk extension is not connected" });
  /** Runs before each request is answered, with how many lists were asked so far: the test's daemon acts here. */
  onRequest: (request: DaemonRequest, lists: number) => void = () => undefined;
  private lists = 0;
  private readonly log: string[];

  constructor(options: { reachable?: boolean; log?: string[] } = {}) {
    this.reachable = options.reachable ?? true;
    this.log = options.log ?? [];
  }

  async open(): Promise<DaemonOpen> {
    if (!this.reachable) return { ok: false, reason: "unreachable" };
    return {
      ok: true,
      session: {
        request: async (message) => {
          this.requests.push(message);
          if (message.type === "list") this.lists += 1;
          this.onRequest(message, this.lists);
          if (message.type === "list") {
            this.log.push(`daemon.list sw=${this.swConnected}`);
            return {
              type: "panes",
              id: "r1",
              panes: this.paneList,
              panels: this.panels.map((id) => ({ window: id })),
              sw: { connected: this.swConnected, connects: this.swConnects },
              gatewayClients: this.gatewayClients,
              paused: this.paused,
            };
          }
          return this.extAnswer(message);
        },
        notify: async (message) => {
          this.notices.push(message);
          this.log.push(`daemon.${message.type} ${message.type === "shutdown" ? message.mode : message.type === "alert" ? message.kind : String(message.paused)}`);
        },
        close: () => undefined,
      },
    };
  }
}
