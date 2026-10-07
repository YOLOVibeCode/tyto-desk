/** A target as Chrome describes it in `Target.*` answers and events: only the fields the policy reads. */
export type TargetFacts = { targetId: string; url: string };

/** Whether a URL is one of Desk's own extension pages or its worker: the terminal (§12). */
export function isDeskUrl(url: unknown, extensionId: string): boolean {
  return typeof url === "string" && url.toLowerCase().startsWith(`chrome-extension://${extensionId}/`);
}

/**
 * The guarded endpoint's knowledge of which targets are Desk's (§12). `desk watch` feeds it from its own
 * `Target.setDiscoverTargets` connection, which hears of every target as Chrome creates it, so a client never names a
 * Desk target the registry has not seen; each client's own answers and events feed it too.
 */
export class HiddenTargets {
  private readonly extensionId: string;
  private readonly hidden = new Set<string>();

  constructor(extensionId: string) {
    this.extensionId = extensionId;
  }

  observe(target: TargetFacts): void {
    if (isDeskUrl(target.url, this.extensionId)) this.hidden.add(target.targetId);
    else this.hidden.delete(target.targetId);
  }

  forget(targetId: string): void {
    this.hidden.delete(targetId);
  }

  isHidden(targetId: unknown): boolean {
    return typeof targetId === "string" && this.hidden.has(targetId);
  }
}

/** What one message turns into: messages for Chrome and messages for the client. */
export type GatewayStep = { toChrome: string[]; toClient: string[] };

/** Methods the guarded endpoint never forwards, whatever their parameters (§12). */
const REFUSED = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Extensions.loadUnpacked", "Extensions.uninstall"]);

/** Target events that describe one target, and where they name it. */
const TARGET_EVENTS = new Set(["Target.targetCreated", "Target.targetInfoChanged", "Target.targetDestroyed", "Target.targetCrashed"]);

/** Ids the gateway gives its own commands to Chrome, counting down from the top of the range CDP allows. */
const FIRST_OWN_ID = 2_147_483_647;

type Message = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; sessionId?: unknown };

function parse(text: string): Message | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Message) : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function facts(value: unknown): TargetFacts | null {
  const info = record(value);
  return typeof info.targetId === "string" && typeof info.url === "string" ? { targetId: info.targetId, url: info.url } : null;
}

/**
 * One client's connection through the guarded endpoint (§12): every CDP domain passes unchanged, except that Desk's
 * own targets never appear (filtered from `Target.getTargets`, target events, and auto-attaches, which the gateway
 * resumes and detaches itself), and commands that would close or crash the browser, install or remove extensions, or
 * reach a Desk target are refused at once with a CDP error, because a dropped command stalls agent-browser for 30 s.
 */
export class GatewayConnection {
  private readonly extensionId: string;
  private readonly hidden: HiddenTargets;
  /** The method of each command still waiting for its answer, by session and id. */
  private readonly pending = new Map<string, string>();
  /** Sessions of Desk targets that an auto-attach opened: nothing on them reaches the client. */
  private readonly hiddenSessions = new Set<string>();
  /** Ids of the gateway's own commands, whose answers are dropped. */
  private readonly ownIds = new Set<number>();
  private nextOwnId = FIRST_OWN_ID;

  constructor(input: { extensionId: string; hidden: HiddenTargets }) {
    this.extensionId = input.extensionId;
    this.hidden = input.hidden;
  }

  fromClient(text: string): GatewayStep {
    const message = parse(text);
    if (message === null || typeof message.method !== "string") return { toChrome: [text], toClient: [] };
    const params = record(message.params);
    if (this.refuses(message.method, params)) {
      const answer: Record<string, unknown> = { id: message.id };
      if (typeof message.sessionId === "string") answer.sessionId = message.sessionId;
      answer.error = { code: -32000, message: `Desk's guarded endpoint refuses ${message.method} here; desk cdp --raw is the browser's own port` };
      return { toChrome: [], toClient: [JSON.stringify(answer)] };
    }
    if (typeof message.id === "number") this.pending.set(this.key(message.sessionId, message.id), message.method);
    return { toChrome: [text], toClient: [] };
  }

  fromChrome(text: string): GatewayStep {
    const message = parse(text);
    if (message === null) return { toChrome: [], toClient: [text] };
    if (typeof message.sessionId === "string" && this.hiddenSessions.has(message.sessionId)) return { toChrome: [], toClient: [] };
    if (typeof message.id === "number") return this.answer(message, text);
    if (typeof message.method !== "string") return { toChrome: [], toClient: [text] };
    const params = record(message.params);

    if (message.method === "Target.attachedToTarget") {
      const target = facts(params.targetInfo);
      if (target !== null) this.hidden.observe(target);
      if (target !== null && this.hidden.isHidden(target.targetId) && typeof params.sessionId === "string") {
        this.hiddenSessions.add(params.sessionId);
        return { toChrome: this.resumeAndDetach(params.sessionId, message.sessionId), toClient: [] };
      }
      return { toChrome: [], toClient: [text] };
    }
    if (message.method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string" && this.hiddenSessions.delete(params.sessionId)) return { toChrome: [], toClient: [] };
      return { toChrome: [], toClient: this.hidden.isHidden(params.targetId) ? [] : [text] };
    }
    if (TARGET_EVENTS.has(message.method)) {
      const target = facts(params.targetInfo);
      if (target !== null) this.hidden.observe(target);
      const id = target?.targetId ?? params.targetId;
      const hide = this.hidden.isHidden(id);
      if (message.method === "Target.targetDestroyed" && typeof id === "string") this.hidden.forget(id);
      return { toChrome: [], toClient: hide ? [] : [text] };
    }
    return { toChrome: [], toClient: [text] };
  }

  private refuses(method: string, params: Record<string, unknown>): boolean {
    if (REFUSED.has(method)) return true;
    if (method.startsWith("Extensions.") && typeof params.id === "string" && params.id.toLowerCase() === this.extensionId) return true;
    if (method.startsWith("Target.") && this.hidden.isHidden(params.targetId)) return true;
    if ((method === "Page.navigate" || method === "Target.createTarget") && isDeskUrl(params.url, this.extensionId)) return true;
    return false;
  }

  private answer(message: Message, text: string): GatewayStep {
    const id = message.id as number;
    if (this.ownIds.delete(id)) return { toChrome: [], toClient: [] };
    const key = this.key(message.sessionId, id);
    const method = this.pending.get(key);
    this.pending.delete(key);
    if (method !== "Target.getTargets") return { toChrome: [], toClient: [text] };
    const result = record(message.result);
    const infos = Array.isArray(result.targetInfos) ? result.targetInfos : [];
    for (const info of infos) {
      const target = facts(info);
      if (target !== null) this.hidden.observe(target);
    }
    const shown = infos.filter((info) => !this.hidden.isHidden(facts(info)?.targetId));
    return { toChrome: [], toClient: [JSON.stringify({ ...message, result: { ...result, targetInfos: shown } })] };
  }

  /** Lets an auto-attached Desk target run and detaches from it, on the session the attach arrived on. */
  private resumeAndDetach(sessionId: string, parent: unknown): string[] {
    const resume = this.ownId();
    const detach = this.ownId();
    const onParent = typeof parent === "string" ? { sessionId: parent } : {};
    return [
      JSON.stringify({ id: resume, method: "Runtime.runIfWaitingForDebugger", params: {}, sessionId }),
      JSON.stringify({ id: detach, method: "Target.detachFromTarget", params: { sessionId }, ...onParent }),
    ];
  }

  private ownId(): number {
    const id = this.nextOwnId;
    this.nextOwnId -= 1;
    this.ownIds.add(id);
    return id;
  }

  private key(sessionId: unknown, id: number): string {
    return `${typeof sessionId === "string" ? sessionId : ""}:${id}`;
  }
}
