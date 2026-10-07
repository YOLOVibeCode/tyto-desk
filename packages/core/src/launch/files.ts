import { AGENT_BROWSER_CONFIG_FILE, AGENT_POLICY_FILE, agentBrowserConfig, agentPolicy } from "../agents/agent-browser.ts";
import type { DeskConfig } from "../config/schema.ts";
import { NATIVE_HOST_NAME } from "../extension/desk-extension.ts";
import { extensionIdFromKey } from "../extension/extension-id.ts";
import { renderManifest } from "../extension/manifest.ts";
import { nativeHostManifest } from "../extension/native-host.ts";
import { nextRenderState, parseRenderState, serializeRenderState } from "../extension/render-state.ts";
import type { NativeHostDir } from "../ports/native-host-dir.ts";
import type { TextFiles } from "../ports/text-files.ts";

/** Files under `~/.desk` are 0600 (§4.1). */
const PRIVATE = 0o600;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Writes `text` at `path` unless the file already holds it. */
async function writeIfChanged(files: TextFiles, path: string, text: string): Promise<void> {
  if ((await files.read(path)) !== text) await files.write(path, text, PRIVATE);
}

export type PreparedFiles =
  | { ok: true; manifestVersion: string; extensionId: string; extensionDir: string }
  | { ok: false; reason: "damaged-install" };

/** The id the rendered manifest's key gives, or `null` when the key is not strict base64 (a damaged install). */
function idOf(key: unknown): string | null {
  if (typeof key !== "string") return null;
  try {
    return extensionIdFromKey(key);
  } catch {
    return null;
  }
}

/**
 * Step 5 of every launch (docs/IMPLEMENTATION.md §6.1): the Desk native-host manifest when it differs; `~/.desk/extension`
 * rendered from the current version's (its files copied when they changed, its manifest rendered with the toggle key
 * and `X.Y.Z.<render serial>`, the serial counted up in `render.json` only when the Desk version or the toggle key
 * changed); `agent-browser.json`; and `agent-policy.json` when there is none (it is never replaced or deleted, §11).
 */
export async function prepareFiles(input: {
  files: TextFiles;
  hosts: NativeHostDir;
  config: DeskConfig;
  deskHome: string;
  appDir: string;
  version: string;
  platform: string;
}): Promise<PreparedFiles> {
  const { files, deskHome } = input;
  const hostText = nativeHostManifest(deskHome);
  if ((await input.hosts.read(NATIVE_HOST_NAME)) !== hostText) await input.hosts.write(NATIVE_HOST_NAME, hostText);

  const source = `${input.appDir}/extension`;
  const target = `${deskHome}/extension`;
  const templateText = await files.read(`${source}/manifest.json`);
  let template: unknown;
  try {
    template = templateText === null ? null : JSON.parse(templateText);
  } catch {
    template = null;
  }
  const renderPath = `${deskHome}/render.json`;
  const previousText = await files.read(renderPath);
  const render = nextRenderState(previousText === null ? null : parseRenderState(previousText), {
    deskVersion: input.version,
    toggleKey: input.config.panel.toggleKey,
  });
  const rendered = renderManifest({
    template,
    deskVersion: input.version,
    serial: render.state.serial,
    toggleKey: input.config.panel.toggleKey,
    platform: input.platform,
  });
  const extensionId = rendered.ok ? idOf(rendered.manifest.key) : null;
  if (!rendered.ok || extensionId === null) return { ok: false, reason: "damaged-install" };
  const names = (await files.names(source)).filter((name) => name !== "manifest.json");
  for (const name of names) {
    const text = await files.read(`${source}/${name}`);
    if (text !== null) await writeIfChanged(files, `${target}/${name}`, text);
  }
  for (const name of await files.names(target)) {
    if (name !== "manifest.json" && !names.includes(name)) await files.remove(`${target}/${name}`);
  }
  await writeIfChanged(files, `${target}/manifest.json`, json(rendered.manifest));
  if (render.changed || previousText === null) await files.write(renderPath, serializeRenderState(render.state), PRIVATE);

  await writeIfChanged(files, `${deskHome}/${AGENT_BROWSER_CONFIG_FILE}`, json(agentBrowserConfig({ config: input.config, deskHome })));
  const policyPath = `${deskHome}/${AGENT_POLICY_FILE}`;
  if ((await files.read(policyPath)) === null) await files.write(policyPath, json(agentPolicy(input.config.agents.policy)), PRIVATE);
  return { ok: true, manifestVersion: rendered.version, extensionId, extensionDir: target };
}
