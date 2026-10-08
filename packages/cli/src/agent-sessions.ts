import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { detachEnvironment, type AgentSession, type AgentSessions } from "@desk/core";
import { assertPathAllowed, runArgv } from "@desk/node";

/**
 * Desk's agent-browser sessions (docs/IMPLEMENTATION.md §11). A Desk pane sets neither a socket directory nor a namespace
 * nor `XDG_RUNTIME_DIR`, so its sessions live in `~/.agent-browser`, each with a `<session>.pid`; a session counts while
 * that pid lives. `close` runs `agent-browser --session <s> close` as argv with `detachEnvironment` (Desk's config, and
 * none of the caller's restore, namespace, cdp or session-name variables), 15 s.
 */
export class NodeAgentSessions implements AgentSessions {
  private readonly dir: string;
  private readonly env: Record<string, string>;
  private readonly binary: string;

  constructor(input: { home: string; deskHome: string; caller: Readonly<Record<string, string | undefined>>; binary?: string }) {
    this.dir = join(input.home, ".agent-browser");
    this.env = detachEnvironment(input.caller, join(input.deskHome, "agent-browser.json"));
    this.binary = input.binary ?? "agent-browser";
  }

  async list(prefix: string): Promise<readonly AgentSession[]> {
    await assertPathAllowed(this.dir);
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const found: AgentSession[] = [];
    for (const name of names.sort()) {
      const session = /^(.+)\.pid$/.exec(name)?.[1];
      if (session === undefined || !session.startsWith(prefix) || !/^\w[\w.-]*$/.test(session)) continue;
      const pid = Number((await readFile(join(this.dir, name), "utf8").catch(() => "")).trim());
      if (!Number.isSafeInteger(pid) || pid <= 1 || !alive(pid)) continue;
      found.push({ session, pid });
    }
    return found;
  }

  async close(session: string): Promise<boolean> {
    if (!/^\w[\w.-]*$/.test(session)) return false;
    const result = await runArgv(this.binary, ["--session", session, "close"], { env: this.env, timeoutMs: 15_000 });
    return result.code === 0;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}
