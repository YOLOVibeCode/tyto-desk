/** Desk allocates both of its ports from this range: never Chrome's usual 9222, never Node's inspector 9229. */
export const DESK_PORT_MIN = 9400;
export const DESK_PORT_MAX = 9899;

/** The extension's `minimum_chrome_version`. */
export const MIN_CHROME_MAJOR = 155;

export type FocusGuard = "auto" | "on" | "off";

/** What `desk config agent-policy` stores; `paused` lives only in agent-policy.json. */
export type AgentPolicyMode = "strict" | "open";

/** `~/.desk/config.json` (docs/IMPLEMENTATION.md §4.2). */
export type DeskConfig = {
  readonly version: 1;
  readonly chrome: {
    readonly app: string;
    readonly userDataDir: string;
    /** The raw debugging port. */
    readonly port: number;
    readonly minMajor: number;
    readonly extraArgs: readonly string[];
    readonly idleQuitMinutes: number;
    readonly relaunchAfterCrash: boolean;
    readonly setContinuePref: boolean;
  };
  readonly gateway: {
    /** The guarded endpoint agents use; stable while the raw port may move. */
    readonly port: number;
    readonly focusGuard: FocusGuard;
  };
  readonly panel: { readonly toggleKey: string };
  readonly terminal: {
    readonly shell: string | null;
    readonly tmux: string | null;
    readonly scrollback: number;
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly macOptionIsMeta: boolean;
    readonly closeOnExit: boolean;
    readonly osc52Write: boolean;
    readonly keymap: Readonly<Record<string, string>>;
  };
  readonly agents: {
    readonly sessionPrefix: string;
    readonly policy: AgentPolicyMode;
    readonly idleTimeout: string;
  };
};

/** Why a config file was refused, and the dotted path of the value. Never the file's text. */
export type ConfigProblem = "not-json" | "unknown-key" | "newer-version" | "invalid";

export type ConfigParse = { ok: true; config: DeskConfig } | { ok: false; problem: ConfigProblem; path: string };

type Check = (value: unknown) => boolean;

/** One check per key of `T`, nesting for objects, so the schema and the type cannot drift apart. */
type Shape<T> = {
  readonly [K in keyof T]-?: T[K] extends readonly unknown[] ? Check : T[K] extends object ? Shape<T[K]> | Check : Check;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isBoolean: Check = (value) => typeof value === "boolean";

const isAbsolutePath: Check = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.includes("\0") && value.length <= 1024;

function integerIn(min: number, max: number): Check {
  return (value) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function numberIn(min: number, max: number): Check {
  return (value) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function nonEmptyText(maxLength: number): Check {
  return (value) => typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function matching(pattern: RegExp): Check {
  return (value) => typeof value === "string" && pattern.test(value);
}

function oneOf(...values: readonly string[]): Check {
  return (value) => typeof value === "string" && values.includes(value);
}

function nullOr(check: Check): Check {
  return (value) => value === null || check(value);
}

const stringList: Check = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

const stringRecord: Check = (value) =>
  isPlainObject(value) && Object.values(value).every((item) => typeof item === "string");

const deskPort = integerIn(DESK_PORT_MIN, DESK_PORT_MAX);

const SCHEMA: Shape<DeskConfig> = {
  version: (value) => value === 1,
  chrome: {
    app: isAbsolutePath,
    userDataDir: isAbsolutePath,
    port: deskPort,
    minMajor: integerIn(MIN_CHROME_MAJOR, 10_000),
    extraArgs: stringList,
    idleQuitMinutes: integerIn(0, 1_440),
    relaunchAfterCrash: isBoolean,
    setContinuePref: isBoolean,
  },
  gateway: { port: deskPort, focusGuard: oneOf("auto", "on", "off") },
  panel: { toggleKey: nonEmptyText(64) },
  terminal: {
    shell: nullOr(isAbsolutePath),
    tmux: nullOr(isAbsolutePath),
    scrollback: integerIn(0, 100_000),
    fontFamily: nonEmptyText(200),
    fontSize: numberIn(6, 72),
    macOptionIsMeta: isBoolean,
    closeOnExit: isBoolean,
    osc52Write: isBoolean,
    keymap: stringRecord,
  },
  agents: {
    sessionPrefix: matching(/^[a-z][a-z0-9-]{0,15}$/),
    policy: oneOf("strict", "open"),
    idleTimeout: matching(/^[1-9][0-9]{0,4}[smh]$/),
  },
};

/** The schema as the validator walks it. */
type SchemaNode = Check | { readonly [key: string]: SchemaNode };

type Problem = { problem: ConfigProblem; path: string };

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function validate(value: unknown, shape: SchemaNode, path: string): Problem | null {
  if (typeof shape === "function") return shape(value) ? null : { problem: "invalid", path };
  if (!isPlainObject(value)) return { problem: "invalid", path };
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(shape, key)) return { problem: "unknown-key", path: joinPath(path, key) };
  }
  for (const [key, check] of Object.entries(shape)) {
    const keyPath = joinPath(path, key);
    if (!Object.hasOwn(value, key)) return { problem: "invalid", path: keyPath };
    const problem = validate(value[key], check, keyPath);
    if (problem) return problem;
  }
  return null;
}

/**
 * Reads config.json strictly: every key of version 1 present and valid, no unknown key, both ports in Desk's range
 * and distinct. A newer version is reported as such, so an older Desk never rewrites it. Parser errors are never
 * passed on, because they quote the file's text.
 */
export function parseDeskConfig(text: string): ConfigParse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "not-json", path: "" };
  }
  if (isPlainObject(json) && typeof json.version === "number" && json.version > 1) {
    return { ok: false, problem: "newer-version", path: "version" };
  }
  const problem = validate(json, SCHEMA, "");
  if (problem) return { ok: false, ...problem };
  const config = json as DeskConfig;
  if (config.chrome.port === config.gateway.port) return { ok: false, problem: "invalid", path: "gateway.port" };
  return { ok: true, config };
}

export function serializeDeskConfig(config: DeskConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
