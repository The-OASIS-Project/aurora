#!/usr/bin/env bash
# Package a built dist/ as a release archive: aurora-<version>.tar.gz (one top-level directory,
# aurora-<version>/) plus SHA256SUMS. Reproducible: files in sorted order, owner and group 0,
# modes normalized (so the builder's umask doesn't show), every timestamp set to the commit's time
# (SOURCE_DATE_EPOCH), no gzip name or time, so the same commit gives the same bytes and anyone can
# rebuild a release and compare (RELEASING.md). Needs GNU tar.
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
(cd "$out" && sha256sum "$name.tar.gz" > SHA256SUMS)
cat "$out/SHA256SUMS"
