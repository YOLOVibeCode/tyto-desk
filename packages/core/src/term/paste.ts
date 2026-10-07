/**
 * Pasted or dropped text without the controls that could act on the shell (docs/IMPLEMENTATION.md §10): ESC, C1 controls
 * (U+0080–U+009F, which include CSI and OSC), DEL, and C0 controls other than tab, CR and LF. A page's "copy this
 * command" can then neither end a bracketed paste early (ESC[201~) nor run a second command unseen.
 */
export function sanitizePaste(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
