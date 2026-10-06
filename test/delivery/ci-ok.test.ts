import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciOk } from "../../scripts/delivery/lib/ci-ok.mjs";
import { repo, runScript } from "./helpers.ts";

const ciOkScript = join(repo, "scripts/delivery/ci-ok.mjs");

type Need = { result: string; outputs?: Record<string, string> };

function needs(over: Record<string, Need> = {}): Record<string, Need> {
  return {
    changes: { result: "success", outputs: { code: "true" } },
    scan: { result: "success" },
    check: { result: "success" },
    macos: { result: "success", outputs: { runtime: "true" } },
    ...over,
  };
}

const docsOnly = { changes: { result: "success", outputs: { code: "false" } }, check: { result: "skipped" }, macos: { result: "skipped" } };
const release = "release-please--branches--main";

describe("ci-ok", () => {
  it.each([
    { label: "scan failed", event: "pull_request", headRef: "feat/x", needs: needs({ scan: { result: "failure" } }) },
    { label: "scan was cancelled", event: "pull_request", headRef: "feat/x", needs: needs({ scan: { result: "cancelled" } }) },
    { label: "change detection failed", event: "pull_request", headRef: "feat/x", needs: needs({ changes: { result: "failure" } }) },
    { label: "check was cancelled on a docs-only PR", event: "pull_request", headRef: "docs/x", needs: needs({ ...docsOnly, check: { result: "cancelled" } }) },
    { label: "code changed and check was skipped", event: "pull_request", headRef: "feat/x", needs: needs({ check: { result: "skipped" } }) },
    { label: "code changed and check failed", event: "pull_request", headRef: "feat/x", needs: needs({ check: { result: "failure" } }) },
    { label: "code changed and macos was skipped", event: "pull_request", headRef: "feat/x", needs: needs({ macos: { result: "skipped" } }) },
    { label: "code changed and macos failed", event: "pull_request", headRef: "feat/x", needs: needs({ macos: { result: "failure" } }) },
    { label: "check failed on main", event: "push", headRef: "", needs: needs({ check: { result: "failure" }, macos: { result: "skipped" } }) },
    { label: "a job did not report", event: "pull_request", headRef: "feat/x", needs: { changes: { result: "success", outputs: { code: "false" } }, scan: { result: "success" } } },
    { label: "a result ci-ok does not know", event: "pull_request", headRef: "feat/x", needs: needs({ check: { result: "neutral" } }) },
    { label: "the release PR while runtime is false", event: "pull_request", headRef: release, needs: needs({ macos: { result: "success", outputs: { runtime: "false" } } }) },
  ])(
    "ci-ok fails when a needed job failed or was cancelled, when code changed and check or macos did not succeed, or on the release PR while runtime is false ($label)",
    ({ event, headRef, needs: given }) => {
      const verdict = ciOk({ needs: given, event, headRef });

      expect(verdict.ok).toBe(false);
      expect(verdict.reasons.length).toBeGreaterThan(0);
    },
  );

  it.each([
    { label: "a docs-only PR without the build jobs", event: "pull_request", headRef: "docs/x", needs: needs(docsOnly) },
    { label: "a code change whose jobs all succeeded", event: "pull_request", headRef: "feat/x", needs: needs() },
    { label: "a push to main, which builds no macOS runtime", event: "push", headRef: "", needs: needs({ macos: { result: "skipped" } }) },
    { label: "the release PR once there is a runtime", event: "pull_request", headRef: release, needs: needs() },
  ])("ci-ok passes $label", ({ event, headRef, needs: given }) => {
    expect(ciOk({ needs: given, event, headRef })).toEqual({ ok: true, reasons: [] });
  });

  it("ci-ok names why it failed and exits 1", async () => {
    const result = await runScript(ciOkScript, [], {
      env: {
        PATH: process.env.PATH ?? "",
        NEEDS: JSON.stringify(needs({ macos: { result: "success", outputs: { runtime: "false" } } })),
        EVENT_NAME: "pull_request",
        HEAD_REF: release,
      },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the release PR has no runtime to release (slice 1c; D58)");
  });
});
