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
  built those exact files;
- release notes generated from the pull requests merged since the last release.

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

## Verifying a release

```bash
sha256sum -c SHA256SUMS
gh attestation verify aurora-<x.y.z>.tar.gz --repo The-OASIS-Project/aurora \
   --signer-workflow The-OASIS-Project/aurora/.github/workflows/release.yml \
   --source-ref refs/tags/v<x.y.z> --deny-self-hosted-runners
```

`gh attestation` needs a current GitHub CLI (from [cli.github.com](https://cli.github.com/)); the
`gh` some Linux distributions package is too old to have it. All three flags matter. `--repo` alone accepts an attestation from any workflow on any branch of
the repository. `--signer-workflow` names the release workflow, and `--source-ref` requires it to
have run from the release's tag, which only an admin can create and nobody can move. That is what
ties the archive to a reviewed commit on `main`. `SHA256SUMS` sits beside the archive, so on its
own it shows the download is intact, not where it came from.

The build is reproducible: the same commit builds the same files (checked between GitHub's x86
runners and an arm64 machine). To rebuild a release yourself and compare:

```bash
git switch --detach v<x.y.z>
npm ci
npm run build
scripts/bundle-files.sh dist | diff - aurora-<x.y.z>.files.sha256 && echo "same files"
```

What's compared is the files, not the archive's bytes: the archive is packed the same way every
time, but different versions of tar or gzip can encode the same files differently. The build
records the commit in `aurora-release.json`, so the rebuild has to be from a clean checkout of
the tag (uncommitted changes mark it `-dirty`, and that file would differ). `.nvmrc` names Node
22 LTS rather than an exact release, so a rebuild long after the release may need the Node 22
release current when it was made.

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
