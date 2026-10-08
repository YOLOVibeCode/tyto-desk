import { sha256Hex } from "../bytes/sha256.ts";
import { NATIVE_HOST_NAME } from "../extension/desk-extension.ts";
import { isManagedFile } from "../install/extras.ts";
import { parseInstalled, serializeInstalled } from "../install/installed.ts";
import type { CodeSigning } from "../ports/code-signing.ts";
import type { LogSink } from "../ports/log-sink.ts";
import type { NativeHostCatalog } from "../ports/native-host-catalog.ts";
import type { NativeHostDir } from "../ports/native-host-dir.ts";
import type { OperatorOutput } from "../ports/operator-output.ts";
import type { Prompter } from "../ports/prompter.ts";
import type { TextFiles } from "../ports/text-files.ts";
import type { ImportResult } from "./import-cookies.ts";

export type ImportNativeHostPorts = {
  /** The main profile's hosts: their names and their manifests. */
  catalog: NativeHostCatalog;
  mainHosts: NativeHostDir;
  /** The Desk profile's host directory, where the copy goes. */
  deskHosts: NativeHostDir;
  signing: CodeSigning;
  files: TextFiles;
  prompter: Prompter;
  out: OperatorOutput;
  audit: LogSink;
};

type Host = { name: string; text: string; path: string; origins: string[] };

/** A host manifest's program and allowed origins, or `null` for anything Chrome would not load. */
function readHost(name: string, text: string): Host | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { path, allowed_origins: origins } = value as { path?: unknown; allowed_origins?: unknown };
  if (typeof path !== "string" || !Array.isArray(origins) || !origins.every((origin) => typeof origin === "string")) return null;
  return { name, text, path, origins: origins as string[] };
}

/**
 * `desk import native-hosts --host <name>` (docs/IMPLEMENTATION.md §14): lists the main profile's native-messaging hosts
 * with each one's program, the team that signed it, and the extensions it answers; after you confirm, copies the named
 * host's manifest, exactly, into the Desk profile, and never Desk's own. The copy's sha256 goes into installed.json, so
 * `desk doctor` can tell when it no longer matches the vendor's and `desk uninstall` removes it. One audit line.
 */
export async function importNativeHost(ports: ImportNativeHostPorts, input: { deskHome: string; host: string }): Promise<ImportResult> {
  const counts = { listed: 0, copied: 0 };
  const finish = (code: ImportResult["code"], message: string): ImportResult => {
    ports.audit.write({ event: "consent", op: "import-native-host", ...counts, code });
    return { code, message };
  };

  const hosts: Host[] = [];
  for (const name of await ports.catalog.names()) {
    if (name === NATIVE_HOST_NAME) continue;
    const text = await ports.mainHosts.read(name);
    const host = text === null ? null : readHost(name, text);
    if (host !== null) hosts.push(host);
  }
  counts.listed = hosts.length;
  for (const host of hosts) {
    const team = await ports.signing.teamId(host.path).catch(() => null);
    ports.out.say(`${host.name}: ${host.path} (${team === null ? "not signed by a team" : `signed by team ${team}`}); answers ${host.origins.join(", ") || "no extension"}`);
  }
  if (input.host === NATIVE_HOST_NAME) return finish(65, `${NATIVE_HOST_NAME} is Desk's own host: desk install writes it`);
  const chosen = hosts.find((host) => host.name === input.host);
  if (chosen === undefined) return finish(65, `Your main Chrome has no native-messaging host named ${input.host}; nothing was copied`);

  const consent = await ports.prompter.confirm(`Copy ${chosen.name} into the Desk profile? The Desk Chrome's extensions it allows can then run ${chosen.path}.`);
  if (!consent.ok) return finish(64, "desk import native-hosts needs an interactive terminal to ask you; nothing was copied");
  if (!consent.yes) return finish(77, "Nothing was copied: you declined");

  await ports.deskHosts.write(chosen.name, chosen.text);
  counts.copied = 1;
  const path = `${input.deskHome.replace(/\/+$/, "")}/installed.json`;
  const installed = parseInstalled((await ports.files.read(path)) ?? "");
  if (installed !== null) {
    const files = installed.files.filter((entry) => !(isManagedFile(entry) && entry.kind === "native-host" && entry.name === chosen.name));
    await ports.files.write(path, serializeInstalled({ ...installed, files: [...files, { kind: "native-host", name: chosen.name, sha256: sha256Hex(chosen.text) }] }), 0o600);
  }
  return finish(0, `Copied ${chosen.name} into the Desk profile; desk uninstall removes it`);
}
