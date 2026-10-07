/** A well-formed `scripts/delivery/node-runtime.json` for `version`, with fake digests, as test checkouts hold it. */
export function nodePinJson(version = "26.10.0"): string {
  return `${JSON.stringify({
    version,
    source: `https://nodejs.org/dist/v${version}/`,
    platforms: {
      "darwin-arm64": { archive: `node-v${version}-darwin-arm64.tar.gz`, archiveSha256: "0".repeat(64), binarySha256: "1".repeat(64) },
      "linux-arm64": { archive: `node-v${version}-linux-arm64.tar.xz`, archiveSha256: "2".repeat(64), binarySha256: "3".repeat(64) },
    },
  })}\n`;
}
