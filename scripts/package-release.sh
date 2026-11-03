#!/usr/bin/env bash
# Package a built dist/ for a release:
#  - aurora-<version>.tar.gz: the bundle, in one top-level aurora-<version>/ directory;
#  - aurora-<version>.files.sha256: every file's SHA-256 (scripts/bundle-files.sh), which is what a
#    rebuild is compared on: the same commit builds the same files (RELEASING.md);
#  - SHA256SUMS: the checksums of those two.
# The archive is consistent for a given tar and gzip (sorted, owner and group 0, modes normalized
# so the builder's umask doesn't show, every timestamp the commit's time, no gzip name or time),
# but its bytes can differ between tar or gzip versions, which is why rebuilds compare the file
# list. Needs GNU tar.
#
#   scripts/package-release.sh <dist-dir> <out-dir>
#
# The version comes from dist/aurora-release.json (written by the build), the timestamp from
# SOURCE_DATE_EPOCH, else the HEAD commit's time.
set -euo pipefail

dist="${1:?usage: package-release.sh <dist-dir> <out-dir>}"
out="${2:?usage: package-release.sh <dist-dir> <out-dir>}"

manifest="$dist/aurora-release.json"
[ -f "$manifest" ] || { echo "no $manifest: build first (npm run build)" >&2; exit 1; }
version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$manifest")"
# The version becomes a path: a version string, nothing else.
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
   echo "not a version: '$version' (from $manifest)" >&2
   exit 1
fi
epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
name="aurora-$version"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R "$dist" "$stage/$name"

mkdir -p "$out"
tar --format=posix --sort=name --owner=0 --group=0 --numeric-owner --mode=u=rwX,go=rX \
   --mtime="@$epoch" \
   --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
   -C "$stage" -cf - "$name" | gzip -9n > "$out/$name.tar.gz"
"$(dirname "$0")/bundle-files.sh" "$stage/$name" > "$out/$name.files.sha256"
(cd "$out" && sha256sum "$name.tar.gz" "$name.files.sha256" > SHA256SUMS)
cat "$out/SHA256SUMS"
