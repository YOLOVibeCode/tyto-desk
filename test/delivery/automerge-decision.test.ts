import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { automergeDecision } from "../../scripts/delivery/lib/automerge-decision.mjs";
import { repo, runScript } from "./helpers.ts";

const script = join(repo, "scripts/delivery/automerge-decision.mjs");

/** One entry of dependabot/fetch-metadata's updated-dependencies-json. */
function update(over: Record<string, unknown> = {}) {
  return {
    dependencyName: "vitest",
    dependencyType: "direct:development",
    updateType: "version-update:semver-patch",
    directory: "/",
    packageEcosystem: "npm_and_yarn",
    targetBranch: "main",
    prevVersion: "5.0.3",
    newVersion: "5.0.4",
    compatScore: 0,
    maintainerChanges: false,
    dependencyGroup: "",
    alertState: "",
    ghsaId: "",
    cvss: 0,
    ...over,
  };
}

describe("the auto-merge decision", () => {
  it.each([
    { label: "a patch of vitest", over: {}, merge: true },
    { label: "a patch of typescript", over: { dependencyName: "typescript" }, merge: true },
    { label: "a patch of yaml", over: { dependencyName: "yaml" }, merge: true },
    { label: "a patch of @types/node", over: { dependencyName: "@types/node" }, merge: true },
    { label: "a patch of @types/chrome", over: { dependencyName: "@types/chrome" }, merge: true },
    { label: "a patch of esbuild", over: { dependencyName: "esbuild" }, merge: false },
    { label: "a patch of vite", over: { dependencyName: "vite" }, merge: false },
    { label: "a patch of @typesx/node", over: { dependencyName: "@typesx/node" }, merge: false },
    { label: "a patch of typescript-eslint", over: { dependencyName: "typescript-eslint" }, merge: false },
    { label: "a minor update of vitest", over: { updateType: "version-update:semver-minor" }, merge: false },
    { label: "a major update of vitest", over: { updateType: "version-update:semver-major" }, merge: false },
    { label: "an update of unknown size", over: { updateType: "" }, merge: false },
    { label: "a runtime dependency", over: { dependencyType: "direct:production" }, merge: false },
    { label: "an indirect dependency", over: { dependencyType: "indirect" }, merge: false },
    { label: "a GitHub Actions update", over: { packageEcosystem: "github_actions", dependencyName: "actions/checkout" }, merge: false },
    { label: "the live image's base", over: { packageEcosystem: "docker", dependencyName: "debian" }, merge: false },
  ])(
    "the auto-merge decision allows only patch updates of @types, typescript, vitest and yaml as development dependencies ($label)",
    ({ over, merge }) => {
      expect(automergeDecision([update(over)]).merge).toBe(merge);
    },
  );

  it("the auto-merge decision refuses a group with any member outside the allowed class", () => {
    const allowed = [update(), update({ dependencyName: "@types/node", dependencyGroup: "dev-tools" })];
    expect(automergeDecision(allowed)).toEqual({ merge: true, reason: "patch updates of allowlisted dev tools" });

    const mixed = [...allowed, update({ dependencyName: "esbuild", dependencyGroup: "dev-tools" })];
    expect(automergeDecision(mixed)).toEqual({
      merge: false,
      reason: "esbuild is not a patch update of an allowlisted dev tool (@types/*, typescript, vitest, yaml)",
    });
    expect(automergeDecision([]).merge).toBe(false);
    expect(automergeDecision({ not: "a list" }).merge).toBe(false);
  });

  it("the auto-merge decision reaches the workflow as one safe line per output", async () => {
    const output = join(await mkdtemp(join(tmpdir(), "automerge-")), "output");
    await writeFile(output, "");
    const injected = update({ dependencyName: "evil\nmerge=true`$(x)`", updateType: "version-update:semver-major" });

    const result = await runScript(script, [], {
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, UPDATED_DEPENDENCIES_JSON: JSON.stringify([injected]) },
    });

    expect(result.code).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "merge=false\nreason=evilmergetruex is not a patch update of an allowlisted dev tool (@types/*, typescript, vitest, yaml)\n",
    );
  });
});
