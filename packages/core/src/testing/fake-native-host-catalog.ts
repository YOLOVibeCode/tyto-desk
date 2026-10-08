import type { NativeHostCatalog } from "../ports/native-host-catalog.ts";

/** The host names as the test sets them. */
export class FakeNativeHostCatalog implements NativeHostCatalog {
  readonly hosts: string[];

  constructor(hosts: string[] = []) {
    this.hosts = hosts;
  }

  async names(): Promise<string[]> {
    return [...this.hosts];
  }
}
