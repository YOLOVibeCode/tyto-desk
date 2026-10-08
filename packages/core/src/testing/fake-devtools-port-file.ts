import type { DevToolsPortFile } from "../ports/devtools-port-file.ts";

/** A `DevToolsActivePort` as the test sets it. */
export class FakeDevToolsPortFile implements DevToolsPortFile {
  value: { port: number; path: string } | null;

  constructor(value: { port: number; path: string } | null = null) {
    this.value = value;
  }

  async read(): Promise<{ port: number; path: string } | null> {
    return this.value;
  }
}
