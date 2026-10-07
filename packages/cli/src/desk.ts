import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./main.ts";

/**
 * `desk.mjs`, the installed runtime's one entry: the launchers run it with Desk Terminal (`desk`, `desk-nmhost`), and
 * the native host runs it to start the daemon. Its directory is the installed version's.
 */
const code = await main({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  runtimeDir: dirname(fileURLToPath(import.meta.url)),
});
process.exit(code);
