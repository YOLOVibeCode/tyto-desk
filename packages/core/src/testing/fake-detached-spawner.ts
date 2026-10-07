import type { DetachedSpawner } from "../ports/detached-spawner.ts";

/** Records every detached start; each gets the next pid, or none while `failing` is set. */
export class FakeDetachedSpawner implements DetachedSpawner {
  readonly started: { file: string; args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  failing = false;
  /** Runs after each start, as the started process would act (a daemon that begins to listen). */
  onStart: () => void = () => undefined;

  async spawn(file: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<number | null> {
    if (this.failing) return null;
    this.started.push({ file, args, env });
    this.onStart();
    return 7000 + this.started.length;
  }
}
