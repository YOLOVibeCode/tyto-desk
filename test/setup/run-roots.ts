import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

/** The directories one test run uses instead of the operator's own. */
export type RunRoots = {
  /** `desk-test-XXXXXX`, created for this run and removed after it. */
  root: string;
  home: string;
  deskHome: string;
  tmp: string;
};

/** Makes a new run root under `base` with empty, 0700 `home`, `desk-home` and `tmp` directories. */
export async function makeRunRoots(base: string): Promise<RunRoots> {
  const root = await mkdtemp(join(base, "desk-test-"));
  await chmod(root, 0o700);
  const roots: RunRoots = {
    root,
    home: join(root, "home"),
    deskHome: join(root, "desk-home"),
    tmp: join(root, "tmp"),
  };
  for (const dir of [roots.home, roots.deskHome, roots.tmp]) {
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
  }
  return roots;
}
