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

/*
 * The check is strict: every entry, `logs/` included, with directory timestamps, so a file a test created and removed
 * again still shows. No Desk process exists in slice 1a, so nothing else writes ~/.desk while the suite runs. How the
 * check treats a running Desk's own writes (panes.json, layout.json, agent-browser.json, run/*.lock, quit.marker,
 * logs/) is the operator's decision before the first slice that runs Desk processes (IMPLEMENTATION §22 D29).
 */

let roots: RunRoots | null = null;
let realDeskBefore: TreeSnapshot | null = null;

/** Gives the run a fresh HOME, DESK_HOME and TMPDIR before any worker starts (workers copy this environment). */
export async function setup(project: TestProject): Promise<void> {
  const realHome = process.env.HOME || userInfo().homedir;
  realDeskBefore = await snapshotTree(join(realHome, ".desk"));
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
  const changes = treeChanges(realDeskBefore, await snapshotTree(realDeskBefore.root));
  if (changes.length > 0) {
    throw new Error(
      `The real ~/.desk changed while the tests ran (${changes.join(", ")}): something wrote outside the run root.`,
    );
  }
}
