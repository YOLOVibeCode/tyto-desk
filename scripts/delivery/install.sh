#!/bin/bash
# Desk's fresh-Mac installer (docs/IMPLEMENTATION.md §23.5, slice D2). A release asset, attested like the tarball: run it
# only as the release notes' snippet does, after `gh release verify-asset` and `gh attestation verify` checked it, and
# never through a pipe (`curl | bash`).
#
#   bash install.sh --version X.Y.Z
#
# It installs exactly that release, checked as `desk update` checks one, in this order, and nothing is downloaded before
# the checks that need no download: macOS on arm64; gh 2.102.0 or later (from Homebrew's paths, never PATH), signed in;
# the commit the tag's exact ref names on main's head, exactly as desk update finds them. Then, before anything is
# extracted: the tarball's sha256 against SHA256SUMS, verify-asset on both, and the tarball's provenance from release.yml
# on exactly that tag and commit; the tarball must be gzip, and every member must sit under desk-X.Y.Z/, never climb out
# with .., and be a file or a directory. Then it runs that runtime's `desk install --from`, which checks that its
# version.json names this release and asks before each step (§15.1).
#
# Exit: 0 installed · 64 usage · 65 a check failed and nothing was installed · 69 gh missing, signed out, or older than
# 2.102.0 · 70 install.sh stopped on an error of its own · 75 GitHub could not be reached, or no temporary directory
# could be made · and otherwise `desk install`'s own code (77: you declined).
set -euo pipefail

readonly REPO="YOLOVibeCode/tyto-desk"
readonly USAGE="usage: bash install.sh --version X.Y.Z"

fail() {
  printf 'install.sh: %s\n' "$2" >&2
  exit "$1"
}

if [ ! -f "${BASH_SOURCE[0]:-}" ]; then
  fail 64 "run install.sh as the file the release snippet verified, never through a pipe"
fi
# Nothing here reads the current directory, and a PATH entry of . or an empty one now names / only. gh is asked about
# github.com and this repository only, whatever the environment names.
cd /
unset GH_HOST GH_REPO

version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      if [ -n "$version" ] || [ $# -lt 2 ]; then fail 64 "$USAGE"; fi
      version=$2
      shift 2
      ;;
    *) fail 64 "$USAGE" ;;
  esac
done
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then fail 64 "$USAGE"; fi
readonly version tag="v$version" top="desk-$version"
readonly tarball="desk-$version-darwin-arm64.tar.gz"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  fail 65 "Desk installs on macOS on Apple silicon only; nothing was installed"
fi

# gh from Homebrew's fixed paths, never PATH, where an earlier gh could vouch for anything; DESK_GH (an absolute path,
# for tests) replaces them, with no fallback: set, even empty, it must name an executable file.
gh=""
if [ -n "${DESK_GH+set}" ]; then
  if [ "${DESK_GH#/}" = "$DESK_GH" ] || [ ! -f "$DESK_GH" ] || [ ! -x "$DESK_GH" ]; then fail 69 "DESK_GH must be the absolute path of gh"; fi
  printf 'install.sh: using DESK_GH=%s\n' "$DESK_GH" >&2
  gh=$DESK_GH
else
  for candidate in /opt/homebrew/bin/gh /usr/local/bin/gh; do
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      gh=$candidate
      break
    fi
  done
fi
if [ -z "$gh" ]; then fail 69 "gh is not installed: brew install gh, then gh auth login"; fi
gh() { "$gh" "$@"; }
gh_line=$(gh --version 2>/dev/null | head -n 1) || true
if [[ ! $gh_line =~ ^gh\ version\ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then fail 69 "gh did not report its version: brew upgrade gh"; fi
if ((10#${BASH_REMATCH[1]} < 2 || (10#${BASH_REMATCH[1]} == 2 && 10#${BASH_REMATCH[2]} < 102))); then
  fail 69 "gh is older than 2.102.0, whose attestation checks Desk cannot rely on: brew upgrade gh"
fi
if ! gh auth status >/dev/null 2>&1; then fail 69 "gh is not signed in: gh auth login"; fi

work=$(mktemp -d "${TMPDIR:-/tmp}/desk-install.XXXXXX" 2>/dev/null) || fail 75 "no temporary directory could be made; nothing was installed"
# Removed on every exit with the exit code kept, even when the tarball's directories were read-only. A 0 before the
# last line is no success: bash 3.2 exits 0 on a fatal error (an unset variable under set -u) after a command that
# succeeded, so that becomes 70.
finished=""
trap 'rc=$?; [ "$rc" -ne 0 ] || [ -n "$finished" ] || rc=70; chmod -R u+rwX "$work" 2>/dev/null || :; rm -rf "$work" 2>/dev/null || :; exit "$rc"' EXIT
chmod 700 "$work"

# gh, failing with 65 when GitHub answered that what was asked for does not exist, and 75 when it could not be reached.
gh_or_fail() {
  local what=$1
  shift
  if gh "$@" 2>"$work/gh.err"; then return 0; fi
  if grep -Eqi 'HTTP 404|not found|no assets match' "$work/gh.err"; then fail 65 "GitHub has no $what; nothing was installed"; fi
  fail 75 "GitHub could not be reached; nothing was installed"
}

# The commit the tag's exact ref names (never a branch of that name), an annotated tag peeled at most twice.
object=$(gh_or_fail "release $tag" api "repos/$REPO/git/ref/tags/$tag" --jq '.object.type + " " + .object.sha') || exit $?
for _ in 1 2; do
  [[ $object =~ ^tag\ ([0-9a-f]{40})$ ]] || break
  object=$(gh_or_fail "tag $tag" api "repos/$REPO/git/tags/${BASH_REMATCH[1]}" --jq '.object.type + " " + .object.sha') || exit $?
done
if [[ ! $object =~ ^commit\ ([0-9a-f]{40})$ ]]; then fail 65 "GitHub did not name the commit of $tag; nothing was installed"; fi
commit=${BASH_REMATCH[1]}
# On main: main's head (branches/main, never a tag named main) is the commit or is ahead of it.
main=$(gh_or_fail "branch main" api "repos/$REPO/branches/main" --jq .commit.sha) || exit $?
if [[ ! $main =~ ^[0-9a-f]{40}$ ]]; then fail 65 "GitHub did not name main's head; nothing was installed"; fi
if [ "$main" != "$commit" ]; then
  status=$(gh_or_fail "commit $commit" api "repos/$REPO/compare/$commit...$main" --jq .status) || exit $?
  if [ "$status" != "ahead" ]; then fail 65 "$tag's commit $commit is not on main; nothing was installed"; fi
fi

mkdir "$work/download"
gh_or_fail "runtime and SHA256SUMS for $tag" release download "$tag" --repo "$REPO" --pattern "$tarball" --pattern SHA256SUMS --dir "$work/download" || exit $?
tb="$work/download/$tarball"
sums="$work/download/SHA256SUMS"
for file in "$tb" "$sums"; do
  if [ ! -f "$file" ] || [ -L "$file" ]; then fail 65 "$tag has no $(basename "$file"); nothing was installed"; fi
done

# SHA256SUMS is a few short lines of ASCII. A larger one, or one with a byte outside tab, CR, LF and printable ASCII, is
# refused before it is read: so trimming means here exactly what it means to core, and no line can take long.
if (($(wc -c <"$sums") > 4096 || $(LC_ALL=C tr -d '\t\r\n -~' <"$sums" | wc -c) != 0)); then
  fail 65 "$tag's SHA256SUMS is not a few lines of ASCII; nothing was installed"
fi
# Exactly one line names the tarball, read as core's parser reads them: trimmed of spaces, tabs and CR, then `<64 hex>`,
# a space, then a space or `*`, then the name, nothing else. Two such lines, or none, refuse the download (core would
# take the last; this is stricter).
expected=""
matches=0
while IFS= read -r line || [ -n "$line" ]; do
  if [ "${#line}" -gt 256 ]; then fail 65 "$tag's SHA256SUMS has a line longer than 256 characters; nothing was installed"; fi
  line=${line#"${line%%[![:space:]]*}"}
  line=${line%"${line##*[![:space:]]}"}
  if [[ $line =~ ^([0-9a-f]{64})\ [\ *](.+)$ ]] && [ "${BASH_REMATCH[2]}" = "$tarball" ]; then
    expected=${BASH_REMATCH[1]}
    matches=$((matches + 1))
  fi
done <"$sums"
if [ "$matches" -ne 1 ]; then expected=""; fi
actual=$(shasum -a 256 "$tb" | awk '{ print $1 }')
if [[ ! $expected =~ ^[0-9a-f]{64}$ ]] || [ "$actual" != "$expected" ]; then
  fail 65 "the download's sha256 does not match SHA256SUMS; nothing was installed"
fi
for file in "$tb" "$sums"; do
  if ! gh release verify-asset "$tag" "$file" --repo "$REPO" >/dev/null 2>&1; then
    fail 65 "gh release verify-asset refused $(basename "$file") of $tag; nothing was installed"
  fi
done
if ! gh attestation verify "$tb" --repo "$REPO" \
  --cert-identity "https://github.com/$REPO/.github/workflows/release.yml@refs/tags/$tag" \
  --source-ref "refs/tags/$tag" --source-digest "$commit" --deny-self-hosted-runners >/dev/null 2>&1; then
  fail 65 "the download's provenance does not name release.yml on refs/tags/$tag at $commit; nothing was installed"
fi

if [ "$(head -c 2 "$tb" | od -An -tx1 | tr -d ' \n')" != "1f8b" ]; then fail 65 "the download is not a gzip tarball; nothing was installed"; fi
if ! LC_ALL=C tar -tzf "$tb" >"$work/members" 2>/dev/null || ! LC_ALL=C tar -tvzf "$tb" >"$work/listing" 2>/dev/null; then
  fail 65 "the tarball cannot be read; nothing was installed"
fi
# Each loop must see at least one line: bash 3.2 skips a loop whose input cannot be opened, and would skip its checks.
members=0
while IFS= read -r member || [ -n "$member" ]; do
  members=$((members + 1))
  case "$member" in
    "$top" | "$top/" | "$top/"*) ;;
    *) fail 65 "the tarball holds $member, outside $top/; nothing was installed" ;;
  esac
  case "/$member/" in
    */../*) fail 65 "the tarball holds $member, which climbs out with ..; nothing was installed" ;;
  esac
done <"$work/members"
if [ "$members" -eq 0 ]; then fail 65 "the tarball lists nothing; nothing was installed"; fi
# Files and directories only: never a link (a hard link lists as a file `link to` another), a FIFO or a device. A bash
# loop, so a missing or failing grep can never let one through.
entries=0
while IFS= read -r entry || [ -n "$entry" ]; do
  entries=$((entries + 1))
  case "$entry" in
    *" link to "* | *" -> "*) fail 65 "the tarball holds a link; nothing was installed" ;;
    -* | d*) ;;
    *) fail 65 "the tarball holds something that is not a file or a directory; nothing was installed" ;;
  esac
done <"$work/listing"
if [ "$entries" -eq 0 ]; then fail 65 "the tarball lists nothing; nothing was installed"; fi

mkdir "$work/runtime"
if ! LC_ALL=C tar -xzf "$tb" -C "$work/runtime" 2>/dev/null; then fail 65 "the tarball could not be extracted; nothing was installed"; fi
runtime="$work/runtime/$top"
node="$runtime/Desk Terminal.app/Contents/MacOS/desk-node"
if [ ! -f "$node" ] || [ ! -x "$node" ] || [ ! -f "$runtime/desk.mjs" ]; then
  fail 65 "the tarball holds no Desk runtime; nothing was installed"
fi

"$node" "$runtime/desk.mjs" install --from "$runtime" --release "$version" --commit "$commit" || exit $?
finished=1
