import { DESK_SKILL } from "../agents/skill.ts";
import { sha256Hex } from "../bytes/sha256.ts";
import { pollUntil } from "../launch/poll.ts";
import type { Clock } from "../ports/clock.ts";
import type { CodeSigning } from "../ports/code-signing.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { LaunchAgents } from "../ports/launch-agents.ts";
import type { Prompter } from "../ports/prompter.ts";
import type { TextFiles } from "../ports/text-files.ts";
import type { Tmux } from "../ports/tmux.ts";
import { parseInstalled, serializeInstalled } from "./installed.ts";
import { addTmuxLine } from "./tmux-line.ts";

/**
 * What install manages outside `~/.desk`, recorded in installed.json's `files` (§4.1) so uninstall removes only that:
 * whole files with their sha256 (the skills), and edits in the user's files (the rule step, the tmux line).
 */
export type ManagedFile =
  | { kind: "skill"; path: string; sha256: string }
  | { kind: "rule-step"; path: string }
  | { kind: "tmux-line"; path: string }
  | { kind: "desk-app"; path: string }
  | { kind: "launch-agent"; label: string }
  /** A third-party host manifest `desk import native-hosts` copied into the Desk profile, with its sha256 (§14). */
  | { kind: "native-host"; name: string; sha256: string };

export type ExtrasPorts = {
  lock: InstanceLock;
  files: TextFiles;
  prompter: Prompter;
  tmux: Tmux | null;
  signing: CodeSigning;
  agents: LaunchAgents;
  clock: Clock;
};

/** Step 0 of the web-access rules (§11): what an agent does when `$DESK_CDP_URL` is set. */
export const WEB_ACCESS_DESK_STEP =
  "0. **Inside Desk** (`$DESK_CDP_URL` is set): the browser is the Desk Chrome next to this terminal; follow the desk skill.\n";

export const DESK_APP_IDENTIFIER = "com.noctusoft.desk.app";
export const LOGIN_AGENT_LABEL = "com.noctusoft.desk.login";

const INSTALL_LOCK_MS = 10_000;

/** A record this Desk wrote; a kind it does not know (a newer Desk's) is someone else's and is written back untouched (D48). */
export function isManagedFile(value: unknown): value is ManagedFile {
  if (typeof value !== "object" || value === null) return false;
  const { kind } = value as { kind?: unknown };
  return kind === "skill" || kind === "rule-step" || kind === "tmux-line" || kind === "desk-app" || kind === "launch-agent" || kind === "native-host";
}

/** A skill install wrote is replaced; one you edited (it matches neither the skill nor the sha256 recorded) is kept. */
async function writeSkill(files: TextFiles, path: string, recorded: readonly ManagedFile[]): Promise<{ record: ManagedFile | null; note: string | null }> {
  const current = await files.read(path);
  const known = recorded.find((entry) => entry.kind === "skill" && entry.path === path);
  const edited = current !== null && current !== DESK_SKILL && (known?.kind !== "skill" || known.sha256 !== sha256Hex(current));
  if (edited) return { record: known ?? null, note: `kept your edited ${path}` };
  if (current !== DESK_SKILL) await files.write(path, DESK_SKILL, 0o644);
  return { record: { kind: "skill", path, sha256: sha256Hex(DESK_SKILL) }, note: null };
}

/** The rule with step 0 before its step 1, or `null` when it has the step already or no step 1 to put it before. */
function withDeskStep(rule: string): string | null {
  if (rule.includes("**Inside Desk**")) return null;
  const at = rule.search(/^1\. /m);
  return at < 0 ? null : `${rule.slice(0, at)}${WEB_ACCESS_DESK_STEP}${rule.slice(at)}`;
}

/** Desk.app (§15.1): a bundle that runs `desk`, for Spotlight and the Dock, signed ad hoc with its own identifier. */
function deskAppFiles(home: string): { path: string; text: string; mode: number }[] {
  const app = `${home}/Applications/Desk.app/Contents`;
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleIdentifier</key><string>com.noctusoft.desk.app</string>",
    "  <key>CFBundleName</key><string>Desk</string>",
    "  <key>CFBundleExecutable</key><string>Desk</string>",
    "  <key>CFBundlePackageType</key><string>APPL</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  const quoted = `'${`${home}/.local/bin/desk`.replaceAll("'", "'\\''")}'`;
  return [
    { path: `${app}/Info.plist`, text: plist, mode: 0o644 },
    { path: `${app}/MacOS/Desk`, text: `#!/bin/sh\nexec ${quoted} "$@"\n`, mode: 0o755 },
  ];
}

/**
 * Install's steps after the version steps (docs/IMPLEMENTATION.md §15.1), under `run/install.lock`: the desk skill for
 * Claude Code and Cursor (always; an edited one is kept), then, each after consent and only when its result is missing:
 * the web-access rule step, the tmux line, and on macOS where Desk may open windows, Desk.app and the login agent.
 * installed.json records what each wrote, so uninstall removes only that. `notes` says what was kept or skipped.
 */
export async function installExtras(
  ports: ExtrasPorts,
  input: { home: string; deskHome: string; platform: string; guiAllowed: boolean },
): Promise<{ ok: true; notes: string[] } | { ok: false; code: 65 | 75; message: string }> {
  const lock = await pollUntil(ports.clock, INSTALL_LOCK_MS, 100, async () => {
    const attempt = await ports.lock.acquire("install");
    return attempt.ok ? attempt : null;
  });
  if (lock === null) return { ok: false, code: 75, message: "another desk install is running; run it again once it is done" };
  try {
    const installedPath = `${input.deskHome}/installed.json`;
    const installed = parseInstalled((await ports.files.read(installedPath)) ?? "");
    if (installed === null) return { ok: false, code: 65, message: `${installedPath} is missing or damaged; run desk install --from <dir> first` };
    const home = input.home.replace(/\/+$/, "");
    const before = installed.files.filter(isManagedFile);
    const records = new Map<string, ManagedFile>();
    const keyOf = (entry: ManagedFile) =>
      entry.kind === "launch-agent" ? `launch-agent:${entry.label}` : entry.kind === "native-host" ? `native-host:${entry.name}` : `${entry.kind}:${entry.path}`;
    for (const entry of before) records.set(keyOf(entry), entry);
    const notes: string[] = [];

    for (const path of [`${home}/.claude/skills/desk/SKILL.md`, `${home}/.cursor/skills/desk/SKILL.md`]) {
      const skill = await writeSkill(ports.files, path, before);
      if (skill.record !== null) records.set(keyOf(skill.record), skill.record);
      if (skill.note !== null) notes.push(skill.note);
    }

    const ask = async (question: string, step: string): Promise<boolean> => {
      const consent = await ports.prompter.confirm(question);
      if (!consent.ok) notes.push(`${step} needs an interactive terminal: run desk install again from one`);
      return consent.ok && consent.yes;
    };

    const rules = [`${home}/.claude/rules/web-access.md`, `${home}/.cursor/rules/web-access.mdc`];
    const missing: { path: string; text: string }[] = [];
    for (const path of rules) {
      const rule = await ports.files.read(path);
      const next = rule === null ? null : withDeskStep(rule);
      if (next !== null) missing.push({ path, text: next });
    }
    if (missing.length > 0 && (await ask(`Add the desk step to your agents' web-access rules (${missing.map((m) => m.path).join(", ")})?`, "the web-access step"))) {
      for (const rule of missing) {
        await ports.files.write(rule.path, rule.text, 0o644);
        records.set(`rule-step:${rule.path}`, { kind: "rule-step", path: rule.path });
      }
    }

    const tmux = await addTmuxLine({ files: ports.files, tmux: ports.tmux, prompter: ports.prompter }, { home });
    if (tmux.added) records.set(`tmux-line:${home}/.tmux.conf`, { kind: "tmux-line", path: `${home}/.tmux.conf` });
    if (tmux.note !== null) notes.push(tmux.note);

    if (input.platform === "darwin" && input.guiAllowed) {
      const app = `${home}/Applications/Desk.app`;
      if ((await ports.files.read(`${app}/Contents/MacOS/Desk`)) === null && (await ask("Add Desk.app to ~/Applications, for Spotlight and the Dock?", "Desk.app"))) {
        for (const file of deskAppFiles(home)) await ports.files.write(file.path, file.text, file.mode);
        await ports.signing.adHocSign(app, DESK_APP_IDENTIFIER);
        records.set(`desk-app:${app}`, { kind: "desk-app", path: app });
      }
      if (!(await ports.agents.installed(LOGIN_AGENT_LABEL)) && (await ask("Start Desk when you log in (a login agent that runs desk)?", "the login agent"))) {
        if (await ports.agents.install(LOGIN_AGENT_LABEL, [`${home}/.local/bin/desk`])) {
          records.set(`launch-agent:${LOGIN_AGENT_LABEL}`, { kind: "launch-agent", label: LOGIN_AGENT_LABEL });
        }
      }
    }

    const others = installed.files.filter((entry) => !isManagedFile(entry));
    await ports.files.write(installedPath, serializeInstalled({ ...installed, files: [...others, ...records.values()] }), 0o600);
    return { ok: true, notes };
  } finally {
    await lock.release();
  }
}
