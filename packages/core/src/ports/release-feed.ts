/** A release or an edge run Desk could update to (docs/IMPLEMENTATION.md §23.5). */
export type ReleaseRef = {
  /** `vMAJOR.MINOR.PATCH` for a release; the run's version for edge. */
  tag: string;
  version: string;
  channel: "stable" | "edge";
  /** The commit GitHub reports for the tag, or the run's head commit. */
  commit: string;
  /** The edge run's id. */
  run?: number;
};

/** `unreachable`: GitHub did not answer in time. */
export type Unreachable = "unreachable";

/**
 * Where updates come from (§23.5). Adapter: packages/cli (stable: the REST API without a token, 30 s per call, 300 MB at
 * most; edge: `gh run list` and `gh run download`). `null` means there is none.
 */
export interface ReleaseFeed {
  /** `releases/latest`, or the newest successful `edge.yml` run on `main` that has the artifact. */
  latest(channel: "stable" | "edge"): Promise<ReleaseRef | null | Unreachable>;
  /** The release tagged `v<version>`. */
  find(version: string): Promise<ReleaseRef | null | Unreachable>;
  /** Whether `commit` is on `main`: `main` is ahead of it or is it. */
  onMain(commit: string): Promise<boolean | Unreachable>;
  /** Whether `head` is strictly ahead of `base` (`compare/<base>...<head>` is `ahead`), so `base` is its ancestor. */
  ahead(base: string, head: string): Promise<boolean | Unreachable>;
  /** Downloads the ref's tarball for `asset` (`darwin-arm64`) and its `SHA256SUMS` into `dir`. */
  fetch(ref: ReleaseRef, asset: string, dir: string): Promise<{ tarball: string; sums: string } | null | Unreachable>;
}
