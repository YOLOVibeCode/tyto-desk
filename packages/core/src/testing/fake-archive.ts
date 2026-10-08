import type { Archive } from "../ports/archive.ts";

/** Extracts to `<dir>/runtime` unless `refuse`; every extraction is recorded. */
export class FakeArchive implements Archive {
  refuse = false;
  readonly extracted: { tarball: string; dir: string }[] = [];
  onExtract: (dir: string) => void = () => undefined;

  async extract(tarball: string, dir: string): Promise<string | null> {
    if (this.refuse) return null;
    this.extracted.push({ tarball, dir });
    this.onExtract(`${dir}/runtime`);
    return `${dir}/runtime`;
  }
}
