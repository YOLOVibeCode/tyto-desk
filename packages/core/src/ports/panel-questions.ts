/**
 * What a panel asks its service worker as it loads (docs/IMPLEMENTATION.md §9): whether it may take the keyboard. An
 * automatic open (`desk watch`) must not; the `focus=0` path alone races Chrome's `setOptions` (D108). Adapter:
 * packages/extension (`chrome.runtime.onMessage`, from the extension's own panel page only).
 */
export interface PanelQuestions {
  onFocusAsked(answer: () => boolean): void;
}
