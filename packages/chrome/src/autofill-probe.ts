import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AutofillVerdict, Clock, OperatorOutput, Prompter, SecurityProbe } from "@desk/core";
import { CdpConnection, type CdpTransport } from "./cdp.ts";

/** The probe's login page: a form Chrome's password manager recognizes, served on 127.0.0.1 only. */
const PAGE = `<!doctype html><title>Desk autofill probe</title><h1>Desk autofill probe</h1>
<p>Sign in with any username and a throwaway password, then save the password when Chrome offers to.</p>
<form method="post" action="/done"><input id="username" name="username" autocomplete="username">
<input id="password" name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>`;
const DONE = "<!doctype html><title>Desk autofill probe</title><p>Signed in. Save the password if Chrome offers to, then answer in the terminal.</p>";
/** How long the reloaded page may take to show its password field. */
const LOAD_MS = 10_000;
/** How long Chrome may take to fill once its suggestion is chosen, while macOS may be asking you. */
const FILL_WAIT_MS = 15_000;
const POLL_MS = 500;
const CENTER = `(() => { const r = document.querySelector('#password')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`;

export type AutofillProbeInput = {
  /** The Desk Chrome's browser WebSocket, or `null` when it is not running. */
  deskBrowser(): Promise<string | null>;
  open(wsUrl: string, timeoutMs: number): Promise<CdpTransport | null>;
  prompter: Prompter;
  out: OperatorOutput;
  clock: Clock;
};

/**
 * `desk doctor --autofill-probe` (docs/IMPLEMENTATION.md §15.2, M17). It serves a login page on 127.0.0.1 in a
 * background tab of the Desk Chrome and asks you to save a throwaway password there. Then it does what any program on
 * the debugging port could: reloads the page, clicks the password field and picks Chrome's suggestion over CDP, and
 * reads the field. Chrome filling it while you say macOS never asked for your screen lock is the warning. A field that
 * stays empty with no prompt means Chrome offered nothing, which proves nothing either way.
 */
export class CdpAutofillProbe implements SecurityProbe {
  private readonly input: AutofillProbeInput;

  constructor(input: AutofillProbeInput) {
    this.input = input;
  }

  async autofill(): Promise<AutofillVerdict> {
    const wsUrl = await this.input.deskBrowser();
    if (wsUrl === null) return "unavailable";
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(req.method === "POST" ? DONE : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      return await this.probe(wsUrl, `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  private async probe(wsUrl: string, url: string): Promise<AutofillVerdict> {
    const transport = await this.input.open(wsUrl, 3_000);
    if (transport === null) return "unavailable";
    const cdp = new CdpConnection(transport);
    const tab = await cdp.send("Target.createTarget", { url, background: true });
    if (!tab.ok) {
      cdp.close();
      return "unavailable";
    }
    let saved = false;
    try {
      this.input.out.say(
        "A tab named Desk autofill probe is open in the Desk Chrome: switch to it, sign in with any username and a throwaway password, and save the password when Chrome offers to.",
      );
      const answer = await this.input.prompter.confirm("Did Chrome save the throwaway password?");
      if (!answer.ok) return "unavailable";
      if (!answer.yes) return "not-saved";
      saved = true;
      const attached = await cdp.send("Target.attachToTarget", { targetId: tab.result.targetId, flatten: true });
      const session = attached.ok && typeof attached.result.sessionId === "string" ? attached.result.sessionId : null;
      if (session === null) return "unavailable";
      this.input.out.say("Desk now reloads that tab and asks Chrome to fill the password, as a program on the debugging port could. Stay on the tab; if macOS asks for Touch ID or your password, cancel.");
      const filled = await this.driveFill(cdp, session, url);
      const asked = await this.input.prompter.confirm("Did macOS ask for Touch ID or your password?");
      if (!asked.ok) return "unavailable";
      if (asked.yes) return "held-for-screen-lock";
      return filled ? "filled-without-screen-lock" : "unavailable";
    } finally {
      await cdp.send("Target.closeTarget", { targetId: tab.result.targetId });
      cdp.close();
      if (saved) this.input.out.say("Delete the throwaway password from the Desk Chrome's Password Manager now.");
    }
  }

  /** Reloads the page, clicks the password field, picks Chrome's first suggestion, and waits for a value a page can read. */
  private async driveFill(cdp: CdpConnection, session: string, url: string): Promise<boolean> {
    const evaluate = async (expression: string): Promise<unknown> => {
      const reply = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, 5_000, session);
      return reply.ok ? (reply.result.result as { value?: unknown } | undefined)?.value : undefined;
    };
    await cdp.send("Page.navigate", { url }, LOAD_MS, session);
    let center: unknown = null;
    for (let waited = 0; waited < LOAD_MS && !isPoint(center); waited += POLL_MS) {
      await this.input.clock.sleep(POLL_MS);
      center = await evaluate(CENTER);
    }
    if (!isPoint(center)) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: center.x, y: center.y, button: "left", clickCount: 1 }, 5_000, session);
    }
    await this.input.clock.sleep(POLL_MS);
    for (const key of [{ key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }]) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, 5_000, session);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, 5_000, session);
    }
    // The value, not :autofill: a previewed suggestion matches :autofill too, but only a filled one reaches the page.
    for (let waited = 0; waited < FILL_WAIT_MS; waited += POLL_MS) {
      if ((await evaluate("document.querySelector('#password')?.value !== ''")) === true) return true;
      await this.input.clock.sleep(POLL_MS);
    }
    return false;
  }
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return typeof value === "object" && value !== null && typeof (value as { x?: unknown }).x === "number" && typeof (value as { y?: unknown }).y === "number";
}
