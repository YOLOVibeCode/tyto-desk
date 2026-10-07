import type { TextFiles } from "../ports/text-files.ts";

/** Files in memory, each with its mode; every write is recorded in order. */
export class MemoryTextFiles implements TextFiles {
  readonly files = new Map<string, { text: string; mode: number }>();
  readonly writes: string[] = [];

  constructor(files: Readonly<Record<string, string>> = {}) {
    for (const [path, text] of Object.entries(files)) this.files.set(path, { text, mode: 0o600 });
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path)?.text ?? null;
  }

  async write(path: string, text: string, mode: number): Promise<void> {
    this.writes.push(path);
    this.files.set(path, { text, mode });
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async names(dir: string): Promise<readonly string[]> {
    const prefix = `${dir.replace(/\/+$/, "")}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map((path) => path.slice(prefix.length))
      .sort();
  }

  async realPath(path: string): Promise<string> {
    return path;
  }

  /** The text at `path`, failing the test when there is none. */
  text(path: string): string {
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`no file at ${path}`);
    return file.text;
  }
}
