/**
 * Desk Terminal's pinned Node (docs/IMPLEMENTATION.md §15.1, §23.6, D49): `scripts/delivery/node-runtime.json` names the
 * version and, per platform, nodejs.org's archive and the sha256 of the archive and of its `bin/node`. The runtime
 * build copies a Node binary only when its sha256 is the pinned one, and the stamp records the pinned version. It lives
 * under scripts/delivery/, an owner-merge path, with the stamp that reads it (D61).
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/** @typedef {{ archive: string; archiveSha256: string; binarySha256: string }} NodePin */
/** @typedef {{ version: string; source: string; platforms: Record<string, NodePin> }} NodeRuntime */

const HEX64 = /^[0-9a-f]{64}$/;
/** An exact version: no range, no leading zero, at most four digits a part. */
const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
/** How much of one name from the file a refusal shows. */
const NAME_SHOWN = 64;
/** The platforms Desk Terminal ships for (darwin-arm64) and the test container runs (linux-arm64): exactly these. */
const PLATFORMS = ["darwin-arm64", "linux-arm64"];
const PIN_KEYS = ["version", "source", "platforms"];
const ENTRY_KEYS = ["archive", "archiveSha256", "binarySha256"];

/**
 * A name from the file, as it may appear in a refusal: its first 64 UTF-16 units (then `...`), JSON-quoted, and every
 * character outside printable ASCII as a `\uXXXX` escape, so no newline, Unicode line separator, C1 control or bidi
 * override in it reaches a log or terminal (the reviews of PRs #29 and #30).
 * @param {string} name
 */
const quoted = (name) =>
  JSON.stringify(name.length > NAME_SHOWN ? `${name.slice(0, NAME_SHOWN)}...` : name).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** At most three names from the file, quoted, then how many more: a refusal stays short whatever the file holds. */
const named = (/** @type {string[]} */ names) => `${names.slice(0, 3).map(quoted).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;

/**
 * A field the record holds itself, never one it inherits (JSON.parse makes none, but a caller or a polluted prototype
 * could).
 * @param {Record<string, unknown>} record
 * @param {string} key
 */
const own = (record, key) => (Object.hasOwn(record, key) ? record[key] : undefined);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The pin, checked (the security reviews of PRs #8 and #15): an exact `X.Y.Z` version; `source` nodejs.org's own
 * directory for it; exactly the darwin-arm64 and linux-arm64 entries, as the file's own keys; each archive
 * nodejs.org's own name for that version and platform, so no field can name a path or another build; lowercase sha256
 * digests; no key it does not know. Anything else throws one line, with any name from the file JSON-quoted: no build
 * goes ahead on a pin it cannot trust.
 * @param {unknown} json
 * @returns {NodeRuntime}
 */
export function parseNodeRuntime(json) {
  if (!isRecord(json)) throw new Error("node-runtime.json is not an object");
  const extra = Object.keys(json).filter((key) => !PIN_KEYS.includes(key));
  if (extra.length > 0) throw new Error(`node-runtime.json has an unknown key ${named(extra)}`);
  const version = own(json, "version");
  const source = own(json, "source");
  const platforms = own(json, "platforms");
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error("node-runtime.json names no exact Node version");
  if (source !== `https://nodejs.org/dist/v${version}/`) throw new Error(`node-runtime.json's source is not https://nodejs.org/dist/v${version}/`);
  if (!isRecord(platforms)) throw new Error("node-runtime.json has no platforms");
  const keys = Object.keys(platforms);
  const unknown = keys.filter((key) => !PLATFORMS.includes(key));
  if (unknown.length > 0) throw new Error(`node-runtime.json names a platform Desk does not build for: ${named(unknown)}`);
  /** @type {Record<string, NodePin>} */
  const checked = {};
  for (const key of PLATFORMS) {
    if (!keys.includes(key)) throw new Error(`node-runtime.json has no ${key} entry`);
    const pin = platforms[key];
    if (!isRecord(pin)) throw new Error(`node-runtime.json's ${key} entry is malformed`);
    const extraInEntry = Object.keys(pin).filter((name) => !ENTRY_KEYS.includes(name));
    if (extraInEntry.length > 0) throw new Error(`node-runtime.json's ${key} entry has an unknown key ${named(extraInEntry)}`);
    const archive = own(pin, "archive");
    const archiveSha256 = own(pin, "archiveSha256");
    const binarySha256 = own(pin, "binarySha256");
    if (archive !== `node-v${version}-${key}.tar.gz` && archive !== `node-v${version}-${key}.tar.xz`) {
      throw new Error(`node-runtime.json's ${key} archive is not nodejs.org's node-v${version}-${key} tarball`);
    }
    if (typeof archiveSha256 !== "string" || !HEX64.test(archiveSha256) || typeof binarySha256 !== "string" || !HEX64.test(binarySha256)) {
      throw new Error(`node-runtime.json's ${key} entry is malformed`);
    }
    checked[key] = { archive, archiveSha256, binarySha256 };
  }
  return { version, source, platforms: checked };
}

/**
 * The pin from `scripts/delivery/node-runtime.json`, checked by `parseNodeRuntime`; a missing file or one that is not
 * JSON throws one line too.
 * @param {string} root the checkout
 * @returns {Promise<NodeRuntime>}
 */
export async function readNodeRuntime(root) {
  const path = join(root, "scripts", "delivery", "node-runtime.json");
  // A regular file only: a symbolic link's diff shows its target, never what is read.
  const stat = await lstat(path).catch(() => null);
  if (stat === null) throw new Error("scripts/delivery/node-runtime.json cannot be read");
  if (!stat.isFile()) throw new Error("scripts/delivery/node-runtime.json is not a regular file");
  /** @type {string} */
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("scripts/delivery/node-runtime.json cannot be read");
  }
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("node-runtime.json is not JSON");
  }
  // One form only: a duplicate key (whose last value wins), an escaped key or other spacing would let a diff show one
  // value while another is read (the reviews of PR #29). A value too deep to write back is not canonical either.
  /** @type {string | null} */
  let canonical;
  try {
    canonical = `${JSON.stringify(json, null, 2)}\n`;
  } catch {
    canonical = null;
  }
  if (canonical !== text) {
    throw new Error("node-runtime.json is not in its canonical form (2-space JSON, LF line endings, one trailing newline, no duplicate or escaped keys)");
  }
  return parseNodeRuntime(json);
}

/**
 * The pin for a platform and architecture, or `null` where Desk Terminal has none: darwin-arm64 for the Mac, and
 * linux-arm64 for the test container only.
 * @param {NodeRuntime} runtime
 * @param {string} platform
 * @param {string} arch
 * @returns {NodePin | null}
 */
export function nodePin(runtime, platform, arch) {
  return Object.hasOwn(runtime.platforms, `${platform}-${arch}`) ? (runtime.platforms[`${platform}-${arch}`] ?? null) : null;
}
