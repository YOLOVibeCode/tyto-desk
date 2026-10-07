import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repo } from "./helpers.ts";

export type OwnerPaths = { paths: string[]; branches: string[] };

/** scripts/delivery/owner-paths.json, as the delivery scripts read it. */
export const ownerPaths = JSON.parse(await readFile(join(repo, "scripts/delivery/owner-paths.json"), "utf8")) as OwnerPaths;

// A file under each owner-merge pattern, as [pattern, file]. A trailing "/**" gets a file inside the directory, and a
// leading "**/" stands for the root and for each directory in `nested`, so such a pattern gives one file per place.
export function ownerPathExamples(nested: readonly string[] = ["packages/node/test"]): [string, string][] {
  return ownerPaths.paths.flatMap((pattern): [string, string][] => {
    const file = pattern.replace(/\/\*\*$/, "/example.txt");
    if (!file.startsWith("**/")) return [[pattern, file]];
    const name = file.slice("**/".length);
    return [[pattern, name], ...nested.map((dir): [string, string] => [pattern, `${dir}/${name}`])];
  });
}
