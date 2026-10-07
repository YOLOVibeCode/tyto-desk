/** The highest render serial; the next one after it is 0 (§23.3: the serial wraps below 65,536). */
const SERIAL_MAX = 65_535;

/**
 * `~/.desk/render.json` (docs/IMPLEMENTATION.md §4.1, §23.3): the serial of the last render that changed the
 * extension, and what that render was made from. Written only under `run/launch.lock`.
 */
export type RenderState = {
  readonly version: 1;
  readonly serial: number;
  readonly deskVersion: string;
  readonly toggleKey: string;
};

/** What a launch renders the extension from. */
export type RenderSource = { readonly deskVersion: string; readonly toggleKey: string };

/**
 * The state after this launch's render: the same serial when the Desk version and the toggle key are the ones last
 * rendered, else the next serial (1 on the first render), wrapping below 65,536.
 */
export function nextRenderState(previous: RenderState | null, source: RenderSource): { changed: boolean; state: RenderState } {
  if (previous !== null && previous.deskVersion === source.deskVersion && previous.toggleKey === source.toggleKey) {
    return { changed: false, state: previous };
  }
  const serial = previous === null ? 1 : (previous.serial + 1) % (SERIAL_MAX + 1);
  return { changed: true, state: { version: 1, serial, deskVersion: source.deskVersion, toggleKey: source.toggleKey } };
}

const KEYS = ["version", "serial", "deskVersion", "toggleKey"];

/** render.json, or `null` when it does not parse or has another shape: the next render then starts at serial 1. */
export function parseRenderState(text: string): RenderState | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  if (Object.keys(record).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(record, key))) return null;
  const { version, serial, deskVersion, toggleKey } = record;
  if (version !== 1 || typeof serial !== "number" || !Number.isInteger(serial) || serial < 0 || serial > SERIAL_MAX) return null;
  if (typeof deskVersion !== "string" || typeof toggleKey !== "string") return null;
  return { version, serial, deskVersion, toggleKey };
}

export function serializeRenderState(state: RenderState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
