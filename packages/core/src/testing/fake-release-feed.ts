import type { ReleaseFeed, ReleaseRef, Unreachable } from "../ports/release-feed.ts";

/** Releases and edge runs the test sets; every call is recorded. */
export class FakeReleaseFeed implements ReleaseFeed {
  stable: ReleaseRef | null | Unreachable = null;
  edge: ReleaseRef | null | Unreachable = null;
  readonly tagged = new Map<string, ReleaseRef>();
  readonly offMain = new Set<string>();
  readonly fetched: { tag: string; asset: string; dir: string }[] = [];
  /** What a fetch writes: the tarball's and SHA256SUMS' paths under the directory. */
  download: (dir: string) => { tarball: string; sums: string } | null = (dir) => ({ tarball: `${dir}/desk.tar.gz`, sums: `${dir}/SHA256SUMS` });

  async latest(channel: "stable" | "edge"): Promise<ReleaseRef | null | Unreachable> {
    return channel === "stable" ? this.stable : this.edge;
  }

  async find(version: string): Promise<ReleaseRef | null | Unreachable> {
    return this.tagged.get(version) ?? null;
  }

  async onMain(commit: string): Promise<boolean | Unreachable> {
    return !this.offMain.has(commit);
  }

  async fetch(ref: ReleaseRef, asset: string, dir: string): Promise<{ tarball: string; sums: string } | null | Unreachable> {
    this.fetched.push({ tag: ref.tag, asset, dir });
    return this.download(dir);
  }
}
