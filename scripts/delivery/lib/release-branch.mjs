/**
 * The release PR's head branch (docs/IMPLEMENTATION.md §23.1, §23.8). release-please 17.6.0, which the pinned
 * release-please-action v5.0.0 bundles, opens a separate pull request for a single package and names its branch
 * `release-please--branches--<target>--components--<component>`, the component being the package name
 * (`release-please-config.json`'s `package-name`); `include-component-in-tag: false` changes only the tag.
 * `test/delivery/release-please.test.ts` derives it from the config, so the two cannot drift apart. ci-ok, the PR
 * check and owner-merge name it; owner-merge reads it from `owner-paths.json`. Dependency-free.
 */
export const RELEASE_BRANCH = "release-please--branches--main--components--tyto-desk";
