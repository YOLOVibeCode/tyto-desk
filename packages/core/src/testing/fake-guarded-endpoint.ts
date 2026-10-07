import type { GuardedEndpoint } from "../ports/guarded-endpoint.ts";

/** Records listens and closes; `listening` resolves at the first listen. `portTaken` makes listening fail. */
export class FakeGuardedEndpoint implements GuardedEndpoint {
  listens = 0;
  closes = 0;
  portTaken = false;
  readonly listening: Promise<void>;
  private resolveListening: () => void = () => undefined;
  private readonly log: string[];

  constructor(log: string[] = []) {
    this.log = log;
    this.listening = new Promise((resolve) => {
      this.resolveListening = resolve;
    });
  }

  async listen(): Promise<{ ok: true } | { ok: false; reason: "port-taken" }> {
    this.listens += 1;
    this.log.push("endpoint.listen");
    if (this.portTaken) return { ok: false, reason: "port-taken" };
    this.resolveListening();
    return { ok: true };
  }

  async close(): Promise<void> {
    this.closes += 1;
    this.log.push("endpoint.close");
  }
}
