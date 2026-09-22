#!/usr/bin/env bash
# Bump the extension version, tag it and push. The tag triggers the release
# workflow (.github/workflows/release.yml), which zips and publishes it.
#
#   scripts/publish.sh            # patch: 0.1.0 -> 0.1.1
#   scripts/publish.sh minor      # 0.1.0 -> 0.2.0
#   scripts/publish.sh major      # 0.1.0 -> 1.0.0
#   scripts/publish.sh 0.3.0      # exact version
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first." >&2
  exit 1
fi

current=$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' manifest.json)
IFS=. read -r major minor patch <<<"$current"

case "${1:-patch}" in
  patch) next="$major.$minor.$((patch + 1))" ;;
  minor) next="$major.$((minor + 1)).0" ;;
  major) next="$((major + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*) next="$1" ;;
  *) echo "Usage: $0 [patch|minor|major|X.Y.Z]" >&2; exit 1 ;;
esac

tag="v$next"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists." >&2
  exit 1
fi

read -rp "Publish wilwid $current -> $next? [y/N] " answer
[[ "$answer" == [yY]* ]] || exit 0

# Publishing the current version (e.g. the first release) just tags it.
if [ "$next" != "$current" ]; then
  # -i.bak works with both GNU and BSD (macOS) sed.
  sed -i.bak "s/\"version\": *\"$current\"/\"version\": \"$next\"/" manifest.json
  rm manifest.json.bak
  git add manifest.json
  git commit -m "Release $tag"
fi
git tag "$tag"
git push --atomic origin HEAD "$tag"

echo "Pushed $tag. The release workflow will publish wilwid-$tag.zip."
