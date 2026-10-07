import type { DeskExtension } from "../ports/desk-extension.ts";

/** Chrome's extensions by id and version; a load gives the extension `loadAs` (the key's id unless a test says else). */
export class FakeDeskExtension implements DeskExtension {
  readonly installed = new Map<string, string>();
  readonly loads: string[] = [];
  loadAs: string | null;
  /** The version a load installs. */
  loadVersion = "0.0.0.0";
  private readonly log: string[];

  constructor(options: { loadAs?: string | null; log?: string[] } = {}) {
    this.loadAs = options.loadAs ?? null;
    this.log = options.log ?? [];
  }

  async installedVersion(id: string): Promise<string | null> {
    return this.installed.get(id) ?? null;
  }

  async load(path: string): Promise<{ ok: true; id: string } | { ok: false; reason: "refused" }> {
    this.loads.push(path);
    this.log.push("extension.load");
    if (this.loadAs === null) return { ok: false, reason: "refused" };
    this.installed.set(this.loadAs, this.loadVersion);
    return { ok: true, id: this.loadAs };
  }
}
