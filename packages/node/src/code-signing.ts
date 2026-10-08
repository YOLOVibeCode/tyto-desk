import type { CodeSigning } from "@desk/core";
import { runArgv } from "./run.ts";
import { assertPathAllowed } from "./test-guard.ts";

const ENV = { PATH: "/usr/bin:/bin" };

/** macOS code signing through `codesign` argv (docs/IMPLEMENTATION.md §3, §15.1), 60 s per call. */
export class NodeCodeSigning implements CodeSigning {
  private readonly codesign: string;

  constructor(codesign = "/usr/bin/codesign") {
    this.codesign = codesign;
  }

  async adHocSign(bundle: string, identifier: string): Promise<boolean> {
    await assertPathAllowed(bundle);
    const args = ["--force", "--sign", "-", "--identifier", identifier, "--timestamp=none", bundle];
    return (await runArgv(this.codesign, args, { env: ENV, timeoutMs: 60_000 })).code === 0;
  }

  async verify(bundle: string): Promise<boolean> {
    await assertPathAllowed(bundle);
    return (await runArgv(this.codesign, ["--verify", "--strict", bundle], { env: ENV, timeoutMs: 60_000 })).code === 0;
  }

  /** `codesign -dv --verbose=2`: its `TeamIdentifier=` line on stderr; `not set`, an error, or no codesign is `null`. */
  async teamId(path: string): Promise<string | null> {
    const result = await runArgv(this.codesign, ["-dv", "--verbose=2", path], { env: ENV, timeoutMs: 10_000 }).catch(() => null);
    if (result === null || result.code !== 0) return null;
    const match = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(result.stderr);
    return match?.[1] ?? null;
  }
}
