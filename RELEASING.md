# Releasing Aurora

A release is a version tag on `main`. Pushing it runs `.github/workflows/release.yml`, which
builds Aurora from a clean checkout, checks it again (typecheck, unit tests, and the smoke test on
the same source) and publishes a GitHub Release with:

- `aurora-<version>.tar.gz`: the built bundle (what DAWN serves at `/aurora`), in one
  `aurora-<version>/` directory, with `aurora-release.json` inside saying what it is;
- `aurora-<version>.files.sha256`: the SHA-256 of every file in the bundle, which a rebuild is
  compared on (below);
- `SHA256SUMS`: the checksums of those two;
- a build attestation for both: GitHub's signed record of which workflow, from which commit,
  built those exact files, kept by GitHub and also attached as `aurora-<version>.intoto.jsonl`;
- release notes, first generated from the pull requests merged since the last release, then
  replaced with a written summary (step 5 below).

## Versions

Aurora has its own [semantic version](https://semver.org/) in `package.json`, independent of
DAWN's. What pairs an Aurora with a DAWN is the wire protocol, not the version numbers: Aurora
speaks one DAWN `protocol` (`src/ingest/contract.ts`), refuses a DAWN that speaks another, and
handles each optional DAWN feature flag being absent.

- **Patch** (1.0.1): fixes only.
- **Minor** (1.1.0): new features, still the same DAWN protocol.
- **Major** (2.0.0): a change people must act on, such as speaking a new DAWN protocol.
- **Pre-release** (1.1.0-rc.1): published as a GitHub pre-release, not as the latest.

## Cutting a release

1. **Bump the version** in a pull request: `npm version <x.y.z> --no-git-tag-version` updates
   `package.json` and `package-lock.json`. Merge it when its checks pass.
2. **Optionally, dry-run the pipeline:** Actions, Release, "Run workflow" on `main`. It builds,
   checks and packages without publishing, and keeps the archive as a workflow artifact.
3. **Tag the merge commit on `main` and push the tag:**

   ```bash
   git switch main && git pull --ff-only
   git tag v<x.y.z>
   git push origin v<x.y.z>
   ```

   Only a repository admin can create a `v*` tag, and nobody can move or delete one once it
   exists (the tag rulesets). A mistake is fixed by releasing the next version, never by
   re-tagging.
4. **Watch the Release workflow.** It refuses a tag that doesn't match `package.json`, a tag
   that isn't a commit on `main`'s first-parent line (a merge or direct commit, which went
   through `main`'s checks), and a version that's already published. If it fails after creating
   the release's draft (a network error while uploading), "Re-run failed jobs" finishes that
   same draft.
5. **Write the release notes.** The workflow publishes GitHub's generated list of merged pull
   requests; replace it with a short summary for people who use Aurora (Releases, Edit, or
   `gh release edit v<x.y.z> --notes-file notes.md`): what Aurora is (for a first-time reader),
   what's new or fixed in words a user would use, which DAWN versions it works with, anything to
   do when upgrading, and a link to the full list of changes
   (`https://github.com/The-OASIS-Project/aurora/compare/v<previous>...v<x.y.z>`). Notes can
   still be edited on an immutable release; its files and tag can't.

## Verifying a release

Download the release's files into a folder of their own (not inside an Aurora checkout), then, in
that folder:

```bash
sha256sum -c SHA256SUMS
for f in aurora-<x.y.z>.tar.gz aurora-<x.y.z>.files.sha256; do
   gh attestation verify "$f" --repo The-OASIS-Project/aurora \
      --signer-workflow The-OASIS-Project/aurora/.github/workflows/release.yml \
      --source-ref refs/tags/v<x.y.z> --deny-self-hosted-runners
done
```

To check against the attestation file attached to the release instead of asking GitHub for it,
add `--bundle aurora-<x.y.z>.intoto.jsonl` to the same command (every release after v1.0.0; v1.0.0's
attestation is kept by GitHub only). That still fetches Sigstore's trust roots. To check on a
machine without internet access, also save them while online with
`gh attestation trusted-root > trusted_root.jsonl` and add
`--custom-trusted-root trusted_root.jsonl` (refresh the saved file before checking a newer
release: Sigstore rotates its keys).

`gh attestation` needs a current GitHub CLI (from [cli.github.com](https://cli.github.com/)); the
`gh` some Linux distributions package is too old to have it. All three flags matter. `--repo`
alone accepts an attestation from any workflow on any branch of the repository.
`--signer-workflow` names the release workflow, and `--source-ref` requires it to have run from
the release's tag, which only an admin can create and nobody can move. That is what ties each
file to a reviewed commit on `main`. Both files are verified: the file list is what a rebuild is
compared on, so it must be the release's own. `SHA256SUMS` sits beside them, so on its own it
shows the download is intact, not where it came from.

The build is reproducible: the same commit builds the same files (checked between GitHub's x86
runners and an arm64 machine). To rebuild a release yourself and compare against its verified
file list (here in `~/aurora-<x.y.z>`, the download folder above):

```bash
git switch --detach v<x.y.z>
git status --porcelain    # must print nothing: a clean checkout of the tag
npm ci
npm run build
scripts/bundle-files.sh dist | diff - ~/aurora-<x.y.z>/aurora-<x.y.z>.files.sha256 && echo "same files"
```

What's compared is the files, not the archive's bytes: the archive is packed the same way every
time, but different versions of tar or gzip can encode the same files differently. The build
records the commit in `aurora-release.json`, so the checkout must be clean: any uncommitted or
untracked file (a release download left in it, say) marks the commit `-dirty`, and that file
would differ. `.nvmrc` names Node 22 LTS rather than an exact release, so a rebuild long after
the release may need the Node 22 release current when it was made.

## Pairing with DAWN

Today Aurora and DAWN are released separately. Each Aurora release names the DAWN protocol it
speaks in its `aurora-release.json` (`"protocol"`), and a DAWN release advertises its own on the
`config` frame and `/api/auth/status`.

A DAWN release can bundle Aurora the way DAWN's release already ships a pinned espeak-ng: the
DAWN repository pins one Aurora release (its version and its archive's SHA-256), and DAWN's
release workflow fetches that archive, checks the checksum and the attestation (with all three
flags above), checks that its `aurora-release.json` speaks DAWN's protocol, and installs it where
DAWN serves `/aurora`.
Moving DAWN to a newer Aurora is then a one-line change to the pin, and the DAWN release lists
Aurora's version beside the daemon's and the satellite's.
