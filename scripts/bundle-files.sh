#!/usr/bin/env bash
# The SHA-256 of every file in a built bundle, one "<hash>  <path>" line each, sorted by path (byte
# order), paths relative to the bundle. This is what a release's reproducibility is checked on:
# the same commit builds the same files, whatever tar or gzip packed the archive (RELEASING.md).
# Portable: GNU coreutils' sha256sum, or shasum on macOS.
#
#   scripts/bundle-files.sh <dir>
set -euo pipefail

dir="${1:?usage: bundle-files.sh <dir>}"
if command -v sha256sum >/dev/null; then
   hash=(sha256sum)
else
   hash=(shasum -a 256)
fi
cd "$dir"
find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do
   "${hash[@]}" "$f"
done
