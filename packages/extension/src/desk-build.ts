/** The Desk version the extension was rendered for: the manifest's `version_name` (§23.3), else its `version`. */
export function deskBuild(): string {
  const manifest = chrome.runtime.getManifest();
  return manifest.version_name ?? manifest.version;
}
