import { listenerIsDesk } from "../launch/classify.ts";
import type { ChromeProfile } from "../ports/chrome-profile.ts";
import type { Clock } from "../ports/clock.ts";
import type { CookieBrowser } from "../ports/cookie-browser.ts";
import type { DeskBrowser } from "../ports/desk-browser.ts";
import type { DevToolsPortFile } from "../ports/devtools-port-file.ts";
import type { ListenerInfo } from "../ports/listener-info.ts";
import type { LogSink } from "../ports/log-sink.ts";
import type { OperatorOutput } from "../ports/operator-output.ts";
import type { Picker } from "../ports/picker.ts";
import type { Prompter } from "../ports/prompter.ts";
import { cookieDomains, cookiesFor, importableCookies } from "./cookies.ts";

export type ImportCookiesPorts = {
  prompter: Prompter;
  picker: Picker;
  out: OperatorOutput;
  /** The main Chrome's `DevToolsActivePort`, its profile (singleton, `Local State`), and the Desk profile. */
  portFile: DevToolsPortFile;
  mainProfile: ChromeProfile;
  deskProfile: ChromeProfile;
  listeners: ListenerInfo;
  browsers: CookieBrowser;
  desk: DeskBrowser;
  clock: Clock;
  /** The audit log: one line per consent operation, counts and exit code only. */
  audit: LogSink;
};

export type ImportCookiesInput = {
  /** The Chrome app both Chromes run (`config.chrome.app`). */
  appRoot: string;
  deskUserDataDir: string;
  /** `--domains`: these, and the picker is not shown. */
  domains?: readonly string[];
};

/**
 * §6.5's codes for a consent operation: 64 no TTY · 65 a request it refuses (Desk's own host, one that does not exist) ·
 * 75 a Chrome is not there or not the right one · 77 you declined.
 */
export type ImportResult = { code: 0 | 64 | 65 | 75 | 77; message: string };

const TURN_ON = "chrome://inspect/#remote-debugging";
/** How long the main Chrome's Allow dialog is waited for (§14 step 3). */
const ALLOW_MS = 60_000;
const DESK_CONNECT_MS = 10_000;
/** How long, and how often, the end waits for the main Chrome's remote debugging to be off (§14 step 7). */
const OFF_WAIT_MS = 5 * 60_000;
const OFF_POLL_MS = 2_000;

/** Whether the listener is the main Chrome: the main profile's singleton, the Chrome app, and no `--user-data-dir`. */
function listenerIsMainChrome(input: { singletonPid: number | null; listenerPid: number | null; image: { exe: string; args: string } | null; appRoot: string }): boolean {
  if (input.singletonPid === null || input.listenerPid === null || input.image === null || input.listenerPid !== input.singletonPid) return false;
  const root = input.appRoot.replace(/\/+$/, "");
  if (input.image.exe !== root && !input.image.exe.startsWith(`${root}/`)) return false;
  return !/(^|\s)--user-data-dir(=|\s|$)/.test(input.image.args);
}

/**
 * `desk import cookies [--domains a,b]` (docs/IMPLEMENTATION.md §14), on an interactive TTY only: after your consent it
 * reads the main Chrome's cookies over the remote debugging you turn on, through a listener it verifies is the main
 * Chrome (its singleton pid, the Chrome app, the default profile); drops expired cookies and Google's account cookies;
 * lets you choose domains (none chosen unless you name them), shows only domains and counts, and asks again before it
 * writes them into the Desk Chrome, verified the same way. It ends by waiting, up to 5 minutes, for the main Chrome's
 * remote debugging to be off. Cookies live only in memory; one audit line records counts and the exit code.
 */
export async function importCookies(ports: ImportCookiesPorts, input: ImportCookiesInput): Promise<ImportResult> {
  const counts = { read: 0, eligible: 0, chosen: 0, set: 0, failed: 0 };
  const finish = (code: ImportResult["code"], message: string): ImportResult => {
    ports.audit.write({ event: "consent", op: "import-cookies", ...counts, code });
    return { code, message };
  };

  const consent = await ports.prompter.confirm("Import cookies from your main Chrome into Desk? You choose the domains next; nothing is written until you confirm.");
  if (!consent.ok) return finish(64, "desk import cookies needs an interactive terminal to ask you; nothing was read");
  if (!consent.yes) return finish(77, "Nothing was read: you declined");

  ports.out.say(`Turn on remote debugging in your main Chrome at ${TURN_ON}. An Allow dialog will appear within 60 s of the next step: allow it once, and deny any other.`);
  const active = await ports.portFile.read();
  if (active === null) return finish(75, `Your main Chrome's remote debugging is off: turn it on at ${TURN_ON}, then run desk import cookies again`);
  const listener = await ports.listeners.listenerPid(active.port);
  const main = listenerIsMainChrome({
    singletonPid: (await ports.mainProfile.singleton())?.pid ?? null,
    listenerPid: listener,
    image: listener === null ? null : await ports.listeners.image(listener),
    appRoot: input.appRoot,
  });
  if (!main) return finish(75, `Something other than your main Chrome answers on port ${active.port}; nothing was read`);

  const mainJar = await ports.browsers.connect(`ws://127.0.0.1:${active.port}${active.path}`, ALLOW_MS);
  if (mainJar === null) return finish(75, "Your main Chrome did not allow the connection within 60 s; nothing was read");
  const all = await mainJar.read().catch(() => null);
  mainJar.close();
  if (all === null) return finish(75, "Your main Chrome did not give its cookies; nothing was read");
  counts.read = all.length;
  const eligible = importableCookies(all, ports.clock.now() / 1000);
  counts.eligible = eligible.length;

  let chosen = eligible;
  if (input.domains !== undefined) chosen = cookiesFor(eligible, input.domains);
  else {
    const domains = cookieDomains(eligible);
    const picked = await ports.picker.pick(
      "Choose the domains whose cookies move into Desk (none is chosen yet):",
      domains.map((entry) => `${entry.domain} (${entry.count} ${entry.count === 1 ? "cookie" : "cookies"})`),
    );
    if (!picked.ok) return finish(64, "desk import cookies needs an interactive terminal to ask you; nothing was written");
    chosen = cookiesFor(eligible, picked.chosen.flatMap((index) => domains[index]?.domain ?? []));
  }
  counts.chosen = chosen.length;
  if (chosen.length === 0) return finish(77, "Nothing was chosen; nothing was written");
  const domainCount = cookieDomains(chosen).length;
  const confirm = await ports.prompter.confirm(`Move ${chosen.length} ${chosen.length === 1 ? "cookie" : "cookies"} for ${domainCount} ${domainCount === 1 ? "domain" : "domains"} into the Desk Chrome?`);
  if (!confirm.ok) return finish(64, "desk import cookies needs an interactive terminal to ask you; nothing was written");
  if (!confirm.yes) return finish(77, "Nothing was written: you declined");

  const desk = await ports.desk.ensure();
  if (desk === null) return finish(75, "The Desk Chrome did not start; nothing was written");
  const deskListener = await ports.listeners.listenerPid(desk.port);
  const isDesk = listenerIsDesk({
    singletonPid: (await ports.deskProfile.singleton())?.pid ?? -1,
    listenerPid: deskListener,
    image: deskListener === null ? null : await ports.listeners.image(deskListener),
    appRoot: input.appRoot,
    userDataDir: input.deskUserDataDir,
  });
  if (isDesk !== "desk") return finish(75, `Something other than the Desk Chrome answers on port ${desk.port}; nothing was written`);
  const deskJar = await ports.browsers.connect(desk.wsUrl, DESK_CONNECT_MS);
  if (deskJar === null) return finish(75, "The Desk Chrome did not answer; nothing was written");
  const written = await deskJar.write(chosen).catch(() => ({ set: 0, failed: chosen.length }));
  deskJar.close();
  counts.set = written.set;
  counts.failed = written.failed;
  ports.out.say(`Moved ${written.set} ${written.set === 1 ? "cookie" : "cookies"} into Desk${written.failed > 0 ? `; ${written.failed} failed` : ""}.`);

  const off = await waitUntilDebuggingOff(ports, active.port);
  return finish(0, off ? "Done: your main Chrome's remote debugging is off" : `Done, but your main Chrome's remote debugging is still on: turn it off at ${TURN_ON} (desk doctor reports it until you do)`);
}

/**
 * §14 step 7: the main Chrome's remote debugging is off once `Local State` says so or its port closes. While it is on,
 * any program can ask to control your main Chrome, so the end says how to turn it off and waits up to 5 minutes.
 */
async function waitUntilDebuggingOff(ports: ImportCookiesPorts, port: number): Promise<boolean> {
  const deadline = ports.clock.now() + OFF_WAIT_MS;
  let told = false;
  for (;;) {
    const enabled = await ports.mainProfile.localStatePref("devtools.remote_debugging.user-enabled");
    if (enabled === false || (await ports.listeners.listenerPid(port)) === null) return true;
    if (!told) {
      told = true;
      ports.out.say(`Now turn off remote debugging in your main Chrome at ${TURN_ON}: while it is on, any program can ask to control your main Chrome.`);
    }
    if (ports.clock.now() >= deadline) return false;
    await ports.clock.sleep(OFF_POLL_MS);
  }
}
