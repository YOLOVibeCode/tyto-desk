import { rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { makeRunRoots, type RunRoots } from "./run-roots.ts";
import { snapshotTree, treeChanges, type TreeSnapshot } from "./tree-snapshot.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** The operator's HOME, captured before this setup replaced it. */
    realHome: string;
    /** The operator's ~/.desk before any test ran. */
    realDeskBefore: TreeSnapshot;
    /** This run's `desk-test-XXXXXX` directory, which holds HOME, DESK_HOME and TMPDIR. */
    runRoot: string;
  }
}

/** A running Desk appends to and rotates its own logs while you develop inside it; every other entry must hold
 * still. Adapters cannot write there anyway: under Vitest they refuse every path under the real home. */
const SKIP = ["logs"];

let roots: RunRoots | null = null;
let realDeskBefore: TreeSnapshot | null = null;

/** Gives the run a fresh HOME, DESK_HOME and TMPDIR before any worker starts (workers copy this environment). */
export async function setup(project: TestProject): Promise<void> {
  const realHome = process.env.HOME || userInfo().homedir;
  realDeskBefore = await snapshotTree(join(realHome, ".desk"), SKIP);
  roots = await makeRunRoots(tmpdir());

  process.env.DESK_TEST_REAL_HOME = realHome;
  process.env.DESK_TEST_ROOT = roots.root;
  process.env.HOME = roots.home;
  process.env.DESK_HOME = roots.deskHome;
  process.env.TMPDIR = roots.tmp;

  project.provide("realHome", realHome);
  project.provide("realDeskBefore", realDeskBefore);
  project.provide("runRoot", roots.root);
}

/** Removes the run root, then fails the run if the real ~/.desk changed while the tests ran. */
export async function teardown(): Promise<void> {
  if (roots) await rm(roots.root, { recursive: true, force: true });
  if (!realDeskBefore) return;
  const changes = treeChanges(realDeskBefore, await snapshotTree(realDeskBefore.root, SKIP));
  if (changes.length > 0) {
    throw new Error(
      `The real ~/.desk changed while the tests ran (${changes.join(", ")}): something wrote outside the run root.`,
    );
  }
}
