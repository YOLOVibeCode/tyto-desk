import type { LaunchAgents } from "../ports/launch-agents.ts";

/** LaunchAgents in memory, by label. */
export class FakeLaunchAgents implements LaunchAgents {
  readonly agents = new Map<string, readonly string[]>();

  async installed(label: string): Promise<boolean> {
    return this.agents.has(label);
  }

  async install(label: string, argv: readonly string[]): Promise<boolean> {
    this.agents.set(label, argv);
    return true;
  }

  async remove(label: string): Promise<boolean> {
    return this.agents.delete(label);
  }
}
