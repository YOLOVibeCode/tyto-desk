import type { ListenerInfo } from "../ports/listener-info.ts";

/** Listeners by port and images by pid, as the test sets them; anything else is unknown. */
export class FakeListenerInfo implements ListenerInfo {
  readonly listeners = new Map<number, number>();
  readonly images = new Map<number, { exe: string; args: string }>();

  async listenerPid(port: number): Promise<number | null> {
    return this.listeners.get(port) ?? null;
  }

  async image(pid: number): Promise<{ exe: string; args: string } | null> {
    return this.images.get(pid) ?? null;
  }
}
