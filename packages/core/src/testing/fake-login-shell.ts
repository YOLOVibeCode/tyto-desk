import type { LoginShell } from "../ports/login-shell.ts";

/** An account whose passwd entry names `shell`. */
export class FakeLoginShell implements LoginShell {
  private readonly shell: string | null;

  constructor(shell: string | null) {
    this.shell = shell;
  }

  async passwdShell(): Promise<string | null> {
    return this.shell;
  }
}
