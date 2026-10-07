import type { CodeSigning } from "@desk/core";
import { runArgv } from "./run.ts";

const ENV = { PATH: "/usr/bin:/bin" };

/** macOS code signing through `codesign` argv (docs/IMPLEMENTATION.md §3, §15.1), 60 s per call. */
export class NodeCodeSigning implements CodeSigning {
  private readonly codesign: string;

  constructor(codesign = "/usr/bin/codesign") {
    this.codesign = codesign;
  }

  async adHocSign(bundle: string, identifier: string): Promise<boolean> {
    const args = ["--force", "--sign", "-", "--identifier", identifier, "--timestamp=none", bundle];
    return (await runArgv(this.codesign, args, { env: ENV, timeoutMs: 60_000 })).code === 0;
  }

  async verify(bundle: string): Promise<boolean> {
    return (await runArgv(this.codesign, ["--verify", "--strict", bundle], { env: ENV, timeoutMs: 60_000 })).code === 0;
  }
}
