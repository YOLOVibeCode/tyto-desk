import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("../fixtures/native-host.mjs", import.meta.url));

/** Single-quoted for /bin/sh; the paths are the suite's own, but quoting costs nothing. */
function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Registers the echo host for one profile, the way Desk registers desk-nmhost (docs/IMPLEMENTATION.md §8): a launcher
 * that execs Node on the host script, and a manifest in `<user-data-dir>/NativeMessagingHosts`, which only that
 * profile reads, allowing only `origin`.
 */
export async function installEchoHost({ userDataDir, name, origin }: { userDataDir: string; name: string; origin: string }): Promise<void> {
  const bin = await mkdtemp(join(tmpdir(), "native-host-"));
  const launcher = join(bin, "desk-live-echo-host");
  await writeFile(launcher, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(HOST_SCRIPT)} "$@"\n`, { mode: 0o700 });
  const manifests = join(userDataDir, "NativeMessagingHosts");
  await mkdir(manifests, { recursive: true, mode: 0o700 });
  const manifest = { name, description: "Desk live-test echo host", path: launcher, type: "stdio", allowed_origins: [origin] };
  await writeFile(join(manifests, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
