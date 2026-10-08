/** macOS code signing of Desk Terminal (docs/IMPLEMENTATION.md §3, §15.1). Adapter: packages/node (`codesign` argv). */
export interface CodeSigning {
  /** Signs the bundle ad hoc with its own identifier (`codesign --sign - --identifier <id> --force`). */
  adHocSign(bundle: string, identifier: string): Promise<boolean>;
  /** `codesign --verify --strict` on the bundle. */
  verify(bundle: string): Promise<boolean>;
  /** The Team ID that signed a program, or `null` when no team did (ad hoc, unsigned, or not macOS). */
  teamId(path: string): Promise<string | null>;
}
