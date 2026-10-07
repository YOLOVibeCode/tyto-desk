import { jsonStringBytes } from "./split.ts";

/**
 * Protocol v1 (docs/IMPLEMENTATION.md §7.2): negotiation, panes' input and output, the layout, the daemon's pane list,
 * the extension calls it relays to the service worker, and the alerts and states `desk` and `desk watch` report. Every message a Desk process
 * reads passes these parsers; anything they do not know, including an unknown key, is dropped. They never echo input.
 */

/** The protocol versions this build speaks. */
export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;

/** The most a client may type in one `in` message, encoded. */
export const IN_DATA_MAX = 64 * 1024;

export type ClientKind = "panel" | "sw" | "cli" | "watch";

/** Extension calls the daemon relays to the service worker (§9); slice 4b adds the tab calls. */
export type ExtOp = "windows" | "focusWindow" | "tabCurrent" | "tabMine";

export type Hello = {
  type: "hello";
  vMin: number;
  vMax: number;
  client: ClientKind;
  build: string;
  /** A panel's window (the extension's window id). */
  window?: number;
};
export type Open = { type: "open"; id: string; pane: string; cols: number; rows: number };
export type In = { type: "in"; pane: string; data: string };
export type Resize = { type: "resize"; pane: string; cols: number; rows: number };
export type List = { type: "list"; id: string };
export type ExtCall = { type: "ext.call"; id: string; op: ExtOp; args?: unknown };
export type ExtResult = { type: "ext.result"; id: string; ok: boolean; value?: unknown; error?: string };
export type Shutdown = { type: "shutdown"; mode: "stop" | "restart" };
export type LayoutGet = { type: "layout.get"; id: string };
/** A layout the daemon checks against §7.2's limits before it saves it (`checkLayout`). */
export type LayoutPut = { type: "layout.put"; id: string; layout: unknown };
export type Ack = { type: "ack"; pane: string; n: number };
export type Visibility = { type: "visibility"; state: "visible" | "hidden" };
export type Detach = { type: "detach"; pane: string };
export type Close = { type: "close"; id: string; pane: string };
/** From `desk watch`: something the panels must show (`terminal-attached`, `agent-state-saved`). */
export type AlertIn = { type: "alert"; kind: string };
export type AgentsState = { type: "agents.state"; paused: boolean };
export type GatewayState = { type: "gateway.state"; clients: number };

export type ClientMessage =
  | Hello
  | Open
  | In
  | Resize
  | List
  | ExtCall
  | ExtResult
  | Shutdown
  | LayoutGet
  | LayoutPut
  | Ack
  | Visibility
  | Detach
  | Close
  | AlertIn
  | AgentsState
  | GatewayState;

export type PaneSummary = { id: string; alive: boolean };
export type HelloReply = {
  type: "hello";
  v: number;
  build: string;
  panes: PaneSummary[];
  notices: string[];
  /** `terminal.closeOnExit`: a pane whose shell exits is removed (§7.3). */
  closeOnExit?: boolean;
};
export type Snapshot = { type: "snapshot"; pane: string; part: number; last: boolean; cols: number; rows: number; data: string };
export type Out = { type: "out"; pane: string; data: string };
export type Exit = { type: "exit"; pane: string; code: number | null; signal: number | null };
export type Detached = { type: "detached"; pane: string; reason: "taken" | "stuck" | "closed" };
export type PaneListEntry = { id: string; alive: boolean; owned: boolean };
export type Panes = {
  type: "panes";
  id: string;
  panes: PaneListEntry[];
  /** The windows whose panel said hello. */
  panels: { window: number }[];
  /** The service worker's connection: whether it is up, and how many times it connected since the daemon started. */
  sw: { connected: boolean; connects: number };
  /** Clients on the guarded endpoint, as `desk watch` last reported them. */
  gatewayClients: number;
  /** Whether agents are paused (`desk agents pause`). */
  paused: boolean;
};
export type Notice = { type: "notice"; kind: string };
export type LayoutMessage = { type: "layout"; id?: string; layout: Record<string, unknown> };
export type Closed = { type: "closed"; pane: string };
export type Alert = { type: "alert"; kind: string };
/** From the native host itself, not the daemon (§9's panel states): why it is about to end. */
export type HostState = { type: "host"; state: "install-damaged" | "no-daemon" | "dropped" };

export type ErrorCode = "E_PROTO" | "E_STALE" | "E_VERB" | "E_NOPANE" | "E_LIMIT" | "E_SPAWN" | "E_NOEXT";

/** Each code's fixed text: an error never carries anything a client sent. */
export const ERROR_TEXT: Readonly<Record<ErrorCode, string>> = {
  E_PROTO: "the message was malformed",
  E_STALE: "no protocol version in common",
  E_VERB: "this client may not send that",
  E_NOPANE: "no such pane, or not its owner",
  E_LIMIT: "over a protocol limit",
  E_SPAWN: "the shell could not start",
  E_NOEXT: "the Desk extension is not connected",
};

export type ErrorMessage = { type: "error"; id?: string; pane?: string; code: ErrorCode; message: string };

export type DaemonMessage =
  | HelloReply
  | Snapshot
  | Out
  | Exit
  | Detached
  | Panes
  | Notice
  | LayoutMessage
  | Closed
  | Alert
  | HostState
  | ErrorMessage
  | ExtCall
  | ExtResult;

/** An error message with its code's fixed text. */
export function errorMessage(code: ErrorCode, about: { id?: string; pane?: string } = {}): ErrorMessage {
  return { type: "error", ...about, code, message: ERROR_TEXT[code] };
}

const PANE_ID = /^p_[0-9abcdefghjkmnpqrstvwxyz]{10}$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const KINDS: readonly string[] = ["panel", "sw", "cli", "watch"];
const OPS: readonly string[] = ["windows", "focusWindow", "tabCurrent", "tabMine"];
const CODES: readonly string[] = Object.keys(ERROR_TEXT);
const COLS_MAX = 1000;
const ROWS_MAX = 500;

/** Whether `id` is a pane id as panels make them: `p_` and 10 lowercase Crockford base32 characters. */
export function isPaneId(id: unknown): id is string {
  return typeof id === "string" && PANE_ID.test(id);
}

type Fields = Readonly<Record<string, (value: unknown) => boolean>>;

const isRequestId = (value: unknown) => typeof value === "string" && REQUEST_ID.test(value);
const isText = (max: number) => (value: unknown) => typeof value === "string" && value.length <= max;
const isBoolean = (value: unknown) => typeof value === "boolean";
const isWhole = (min: number, max: number) => (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const isOneOf = (values: readonly string[]) => (value: unknown) => typeof value === "string" && values.includes(value);
const isNullOr = (check: (value: unknown) => boolean) => (value: unknown) => value === null || check(value);
const isAnything = () => true;
const isListOf = (check: (value: unknown) => boolean, max: number) => (value: unknown) =>
  Array.isArray(value) && value.length <= max && value.every(check);
const isInput = (value: unknown) => typeof value === "string" && jsonStringBytes(value) - 2 <= IN_DATA_MAX;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is an object with exactly the `required` keys, any of the `optional` ones, and nothing else, each
 * passing its check.
 */
function shaped(value: unknown, required: Fields, optional: Fields = {}): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) return false;
  }
  for (const [key, check] of Object.entries(required)) {
    if (!Object.hasOwn(value, key) || !check(value[key])) return false;
  }
  for (const [key, check] of Object.entries(optional)) {
    if (Object.hasOwn(value, key) && !check(value[key])) return false;
  }
  return true;
}

const isType = (type: string) => (value: unknown) => value === type;
const size = { cols: isWhole(1, COLS_MAX), rows: isWhole(1, ROWS_MAX) };
const windowId = isWhole(0, 2 ** 31 - 1);

const CLIENT_SHAPES: Readonly<Record<string, { required: Fields; optional?: Fields }>> = {
  hello: {
    required: { type: isType("hello"), vMin: isWhole(1, 1000), vMax: isWhole(1, 1000), client: isOneOf(KINDS), build: isText(128) },
    optional: { window: windowId },
  },
  open: { required: { type: isType("open"), id: isRequestId, pane: isPaneId, ...size } },
  in: { required: { type: isType("in"), pane: isPaneId, data: isInput } },
  resize: { required: { type: isType("resize"), pane: isPaneId, ...size } },
  list: { required: { type: isType("list"), id: isRequestId } },
  "ext.call": { required: { type: isType("ext.call"), id: isRequestId, op: isOneOf(OPS) }, optional: { args: isAnything } },
  "ext.result": {
    required: { type: isType("ext.result"), id: isRequestId, ok: isBoolean },
    optional: { value: isAnything, error: isText(200) },
  },
  shutdown: { required: { type: isType("shutdown"), mode: isOneOf(["stop", "restart"]) } },
  "layout.get": { required: { type: isType("layout.get"), id: isRequestId } },
  "layout.put": { required: { type: isType("layout.put"), id: isRequestId, layout: isRecord } },
  ack: { required: { type: isType("ack"), pane: isPaneId, n: isWhole(0, 2 ** 31 - 1) } },
  visibility: { required: { type: isType("visibility"), state: isOneOf(["visible", "hidden"]) } },
  detach: { required: { type: isType("detach"), pane: isPaneId } },
  close: { required: { type: isType("close"), id: isRequestId, pane: isPaneId } },
  alert: { required: { type: isType("alert"), kind: isText(64) } },
  "agents.state": { required: { type: isType("agents.state"), paused: isBoolean } },
  "gateway.state": { required: { type: isType("gateway.state"), clients: isWhole(0, 10_000) } },
};

const isPaneSummary = (value: unknown) => shaped(value, { id: isPaneId, alive: isBoolean });
const isPaneListEntry = (value: unknown) => shaped(value, { id: isPaneId, alive: isBoolean, owned: isBoolean });

const DAEMON_SHAPES: Readonly<Record<string, { required: Fields; optional?: Fields }>> = {
  hello: {
    required: {
      type: isType("hello"),
      v: isWhole(1, 1000),
      build: isText(128),
      panes: isListOf(isPaneSummary, 64),
      notices: isListOf(isText(64), 16),
    },
    optional: { closeOnExit: isBoolean },
  },
  snapshot: {
    required: { type: isType("snapshot"), pane: isPaneId, part: isWhole(0, 10_000), last: isBoolean, ...size, data: isText(2 ** 20) },
  },
  out: { required: { type: isType("out"), pane: isPaneId, data: isText(2 ** 20) } },
  exit: { required: { type: isType("exit"), pane: isPaneId, code: isNullOr(isWhole(-1000, 1000)), signal: isNullOr(isWhole(0, 128)) } },
  detached: { required: { type: isType("detached"), pane: isPaneId, reason: isOneOf(["taken", "stuck", "closed"]) } },
  panes: {
    required: {
      type: isType("panes"),
      id: isRequestId,
      panes: isListOf(isPaneListEntry, 64),
      panels: isListOf((value) => shaped(value, { window: windowId }), 64),
      sw: (value) => shaped(value, { connected: isBoolean, connects: isWhole(0, 2 ** 31 - 1) }),
      gatewayClients: isWhole(0, 10_000),
      paused: isBoolean,
    },
  },
  notice: { required: { type: isType("notice"), kind: isText(64) } },
  layout: { required: { type: isType("layout"), layout: isRecord }, optional: { id: isRequestId } },
  closed: { required: { type: isType("closed"), pane: isPaneId } },
  alert: { required: { type: isType("alert"), kind: isText(64) } },
  host: { required: { type: isType("host"), state: isOneOf(["install-damaged", "no-daemon", "dropped"]) } },
  error: {
    required: { type: isType("error"), code: isOneOf(CODES), message: isText(200) },
    optional: { id: isRequestId, pane: isPaneId },
  },
  "ext.call": CLIENT_SHAPES["ext.call"] ?? { required: {} },
  "ext.result": CLIENT_SHAPES["ext.result"] ?? { required: {} },
};

function parseShaped<T>(value: unknown, shapes: Readonly<Record<string, { required: Fields; optional?: Fields }>>): T | null {
  if (!isRecord(value) || typeof value.type !== "string" || !Object.hasOwn(shapes, value.type)) return null;
  const shape = shapes[value.type];
  if (shape === undefined || !shaped(value, shape.required, shape.optional)) return null;
  return value as T;
}

/** A line a client sent the daemon, or `null`. A parser error's text is never kept: it quotes the input. */
export function parseClientMessage(line: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return parseShaped<ClientMessage>(value, CLIENT_SHAPES);
}

/** A message from the daemon (already parsed JSON: the extension gets objects from Chrome), or `null`. */
export function parseDaemonMessage(value: unknown): DaemonMessage | null {
  return parseShaped<DaemonMessage>(value, DAEMON_SHAPES);
}
