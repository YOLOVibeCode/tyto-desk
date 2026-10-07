import type { Clock } from "../ports/clock.ts";
import type { DaemonClient } from "../ports/daemon-client.ts";
import type { DeskWindow, ExtensionBridge } from "../ports/extension-bridge.ts";
import type { PanelOpener } from "../ports/panel-opener.ts";
import { pollUntil } from "./poll.ts";

const PANEL_HELLO_MS = 5_000;
const NEW_WINDOW_MS = 5_000;
const POLL_MS = 100;

export type PanelResult = { ok: true; createdWindow: boolean } | { ok: false; message: string };

/** The window the panel opens in: the last-focused one, else the focused one, else the first. */
function targetWindow(windows: readonly DeskWindow[]): DeskWindow | undefined {
  return windows.find((w) => w.lastFocused) ?? windows.find((w) => w.focused) ?? windows[0];
}

/** Whether the daemon lists a panel that said hello from this window. */
async function panelIn(daemon: DaemonClient, windowId: number): Promise<boolean> {
  const opened = await daemon.open("cli");
  if (!opened.ok) return false;
  try {
    const reply = await opened.session.request({ type: "list" });
    return reply?.type === "panes" && reply.panels.some((panel) => panel.window === windowId);
  } finally {
    opened.session.close();
  }
}

/**
 * Step 12 (docs/IMPLEMENTATION.md §6.1, core/launch/panel.ts): the worker lists the normal windows. With none, Chrome
 * opens one first. A window that already shows the panel is focused. Otherwise the toolbar action on a tab target of
 * the last-focused window opens the panel there, and the launch waits for that window's panel to say hello (5 s).
 */
export async function ensurePanel(input: {
  bridge: ExtensionBridge;
  panels: PanelOpener;
  daemon: DaemonClient;
  clock: Clock;
  extensionId: string;
}): Promise<PanelResult> {
  let windows = await input.bridge.windows();
  if (windows === null) return { ok: false, message: "the Desk extension did not answer for its windows" };
  let createdWindow = false;
  if (windows.length === 0) {
    if (!(await input.panels.newWindow())) return { ok: false, message: "Chrome did not open a window" };
    createdWindow = true;
    windows = await pollUntil(input.clock, NEW_WINDOW_MS, POLL_MS, async () => {
      const listed = await input.bridge.windows();
      return listed !== null && listed.length > 0 ? listed : null;
    });
    if (windows === null) return { ok: false, message: "Chrome's new window did not appear" };
  }
  const showing = windows.find((w) => w.panelOpen);
  if (showing !== undefined) {
    await input.bridge.focusWindow(showing.id);
    return { ok: true, createdWindow };
  }
  const target = targetWindow(windows);
  if (target === undefined) return { ok: false, message: "Chrome has no window for the panel" };
  const tab = await input.panels.tabTargetInWindow(target.id);
  if (tab === null) return { ok: false, message: `Chrome's window ${target.id} has no tab to open the panel from` };
  if (!(await input.panels.open(input.extensionId, tab))) return { ok: false, message: "Chrome did not run the Desk toolbar action" };
  const hello = await pollUntil(input.clock, PANEL_HELLO_MS, POLL_MS, async () => ((await panelIn(input.daemon, target.id)) ? true : null));
  if (hello === null) return { ok: false, message: `the Desk panel did not open in window ${target.id} within 5 s` };
  return { ok: true, createdWindow };
}
