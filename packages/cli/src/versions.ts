import { join } from "node:path";
import { listVersions, retainVersions, rollbackVersion, useVersion, type Prompter, type VersionsPorts } from "@desk/core";
import { NodeAppVersions, NodeInstanceLock, NodeProcessInfo, NodeTextFiles, SystemClock } from "@desk/node";
import type { CommandResult } from "./install.ts";

function ports(deskHome: string, prompter: Prompter): VersionsPorts {
  return {
    versions: new NodeAppVersions(deskHome),
    files: new NodeTextFiles(),
    lock: new NodeInstanceLock(join(deskHome, "run")),
    processes: new NodeProcessInfo(),
    prompter,
    clock: new SystemClock(),
  };
}

/** `desk versions`, `desk use <version>`, `desk rollback` (docs/IMPLEMENTATION.md §23.5). */
export async function versionsCommand(
  input: { deskHome: string; prompter: Prompter } & ({ action: "list" } | { action: "use"; version: string } | { action: "rollback" }),
): Promise<CommandResult> {
  const p = ports(input.deskHome, input.prompter);
  switch (input.action) {
    case "list":
      return listVersions(p, { deskHome: input.deskHome });
    case "use":
      return useVersion(p, { deskHome: input.deskHome, version: input.version });
    case "rollback":
      return rollbackVersion(p, { deskHome: input.deskHome });
    default: {
      const never: never = input;
      throw new Error(`unknown versions action ${JSON.stringify(never)}`);
    }
  }
}

/** Retention after an install switched `current` (§23.5 rule 7). */
export async function retainAfterInstall(deskHome: string, prompter: Prompter): Promise<void> {
  await retainVersions(ports(deskHome, prompter), { deskHome });
}
