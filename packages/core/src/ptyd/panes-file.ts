import type { PaneRecord, PanesFile } from "../ports/pane-store.ts";

const PANE_ID = /^p_[0-9abcdefghjkmnpqrstvwxyz]{10}$/;
const RECORD_KEYS = ["cwd", "tmux", "lastTmux", "shell"];
/** Absolute, at most 4,096 characters, no control characters. */
const isPath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
/** A tmux session name: printable, at most 256 characters. */
const isSession = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): PaneRecord | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !RECORD_KEYS.includes(key))) return null;
  const { cwd, tmux, lastTmux, shell } = value;
  if (!(cwd === null || isPath(cwd)) || !(tmux === null || isSession(tmux)) || !(lastTmux === null || isSession(lastTmux)) || !isPath(shell)) return null;
  return { cwd, tmux, lastTmux, shell };
}

/**
 * `panes.json` as read at the daemon's start (§4.3): `panes` when this build can read it, else `null` with `recovered`
 * true, so the caller moves the file aside: it does not parse, has a key this build does not know (a record holds only
 * cwd, tmux, lastTmux and shell), names something that is not a pane id, or has a newer version.
 */
export function parseStoredPanes(text: string): { panes: PanesFile | null; recovered: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { panes: null, recovered: true };
  }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "version" && key !== "panes") || value.version !== 1 || !isRecord(value.panes)) {
    return { panes: null, recovered: true };
  }
  const panes: Record<string, PaneRecord> = {};
  for (const [id, entry] of Object.entries(value.panes)) {
    const parsed = record(entry);
    if (!PANE_ID.test(id) || parsed === null) return { panes: null, recovered: true };
    panes[id] = parsed;
  }
  return { panes: { version: 1, panes }, recovered: false };
}
