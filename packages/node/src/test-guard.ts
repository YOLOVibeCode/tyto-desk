import { realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The environment the guard reads: `VITEST`, plus `DESK_TEST_REAL_HOME` and `DESK_TEST_ROOT` from the global setup. */
export type GuardEnv = Readonly<Record<string, string | undefined>>;

/** A test reached for something that belongs to the operator. */
export class TestIsolationError extends Error {
  override name = "TestIsolationError";
}

/** Chrome's usual debugging port, Node's inspector, and the range Desk allocates its ports from. */
export function isReservedPort(port: number): boolean {
  return port === 9222 || port === 9229 || (port >= 9400 && port <= 9899);
}

function underVitest(env: GuardEnv): boolean {
  return env.VITEST !== undefined;
}

/** Case-insensitive on purpose: macOS volumes usually are, and refusing too much is safe. */
function within(path: string, dir: string): boolean {
  const p = path.toLowerCase();
  const d = dir.toLowerCase().replace(/\/+$/, "");
  return p === d || p.startsWith(`${d}/`);
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/**
 * Resolves symlinks in the longest existing prefix of `path`, so a link cannot smuggle a path elsewhere. `path` has no
 * `..` segment (the guard refuses those first), so resolving the prefix and appending the rest is what the kernel does.
 */
async function realPathOfNearest(path: string): Promise<string> {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch (err) {
      if (!isMissing(err)) throw err;
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** The account's home from the user database, which no HOME override changes; `null` when there is no entry. */
function accountHome(): string | null {
  try {
    return userInfo().homedir;
  } catch (err) {
    // Node reports a uid with no passwd entry (some containers) as ERR_SYSTEM_ERROR from uv_os_get_passwd.
    if (err instanceof Error && "code" in err && (err.code === "ERR_SYSTEM_ERROR" || err.code === "ENOENT")) return null;
    throw err;
  }
}

async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if (isMissing(err)) return path;
    throw err;
  }
}

/** A file's identity, `dev:ino`, or `null` when it does not exist. Two spellings of one directory share it. */
async function identityOf(path: string): Promise<string | null> {
  try {
    const st = await stat(path, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** The identities of `path`'s nearest existing ancestor (itself, when it exists) and of every directory above it. */
async function ancestorIdentities(path: string): Promise<string[]> {
  const identities: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    const identity = await identityOf(current);
    if (identity !== null) identities.push(identity);
    if (dirname(current) === current) return identities;
  }
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Under Vitest, refuses a relative path, a path with a `..` segment (after a symlink the kernel applies `..` to the
 * link's target, which lexical resolution cannot see; adapters take explicit roots and never need one), and any path
 * inside the operator's real home directory (the HOME captured before the test setup replaced it, and the account's
 * home). "Inside" is judged by spelling (also after resolving symlinks, and ignoring case) and by identity: a
 * directory above the path that is the home itself under another name, such as macOS's
 * `/System/Volumes/Data/Users/<you>` firmlink, which `realpath` leaves as it is. This run's own root is allowed even
 * when the system temp directory lives under the home. Outside Vitest it does nothing.
 */
export async function assertPathAllowed(path: string, env: GuardEnv = process.env): Promise<void> {
  if (!underVitest(env)) return;
  if (!isAbsolute(path)) {
    throw new TestIsolationError(`refused "${path}" under Vitest: adapters take an absolute path`);
  }
  if (path.split("/").includes("..")) {
    throw new TestIsolationError(`refused "${path}" under Vitest: adapters take a path without ".." segments`);
  }
  const named = [accountHome(), env.DESK_TEST_REAL_HOME].filter((h): h is string => Boolean(h));
  const homes = [...named, ...(await Promise.all(named.map(realPathOrSelf)))];
  const runRoots = env.DESK_TEST_ROOT ? [env.DESK_TEST_ROOT, await realPathOrSelf(env.DESK_TEST_ROOT)] : [];
  const lexical = resolve(path);
  const real = await realPathOfNearest(lexical);
  for (const candidate of [lexical, real]) {
    if (runRoots.some((root) => within(candidate, root))) continue;
    const home = homes.find((h) => within(candidate, h));
    if (home !== undefined) {
      throw new TestIsolationError(`refused ${path} under Vitest: it is inside the real home directory ${home}`);
    }
  }
  const homeIdentities = (await Promise.all(named.map(identityOf))).filter(notNull);
  const rootIdentities = env.DESK_TEST_ROOT ? [await identityOf(env.DESK_TEST_ROOT)].filter(notNull) : [];
  for (const identity of await ancestorIdentities(real)) {
    if (rootIdentities.includes(identity)) return;
    if (homeIdentities.includes(identity)) {
      throw new TestIsolationError(`refused ${path} under Vitest: it is inside the real home directory, by identity`);
    }
  }
}

/** Under Vitest, refuses 9222, 9229 and 9400–9899, so no test reaches the operator's Chrome or Desk. */
export function assertPortAllowed(port: number, env: GuardEnv = process.env): void {
  if (underVitest(env) && isReservedPort(port)) {
    throw new TestIsolationError(
      `refused reserved port ${port} under Vitest: 9222, 9229 and 9400-9899 belong to the operator's Chrome and Desk`,
    );
  }
}
