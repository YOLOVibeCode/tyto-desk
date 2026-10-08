import type { NativeHostDir } from "../ports/native-host-dir.ts";

/** Host manifests in memory, by name; writes are recorded. */
export class MemoryNativeHostDir implements NativeHostDir {
  readonly manifests = new Map<string, string>();
  readonly writes: string[] = [];

  async read(name: string): Promise<string | null> {
    return this.manifests.get(name) ?? null;
  }

  async write(name: string, text: string): Promise<void> {
    this.writes.push(name);
    this.manifests.set(name, text);
  }

  async remove(name: string): Promise<void> {
    this.manifests.delete(name);
  }
}
