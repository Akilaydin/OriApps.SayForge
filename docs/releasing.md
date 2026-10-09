# Releasing SayForge

Development goes into `main`. Only a push to the long-lived `release` branch runs
`.github/workflows/release.yml`; pushes to `main`, tags and PRs do not publish.
Successful CI publishes a public, non-prerelease GitHub Release automatically.
There is no draft, approval step or in-app updater.

## Prepare a version

1. On `main`, choose a stable `major.minor.patch` version greater than every
   existing `v<version>` tag. Historic upstream tags also reserve their versions.
2. Update `client/src-tauri/tauri.conf.json`, `client/package.json` and
   `client/src-tauri/Cargo.toml`. Synchronize the root package versions in
   `client/package-lock.json` and the `sayforge` entry in `client/src-tauri/Cargo.lock`.
   Record the changes in `CHANGELOG.md`, then review and merge into `main`.
3. Open and merge a PR from `main` into `release`. For the initial release only,
   create `release` from the reviewed stable `main` and push it.
4. Follow **Actions → Windows release**. After tests, packaging and verification,
   CI creates `v<version>` at the exact tested push commit and publishes
   **SayForge v<version>** with one NSIS `.exe` installer, `SHA256SUMS.txt`, `LICENSE`
   and `THIRD_PARTY_NOTICES.md`. GitHub also provides corresponding source archives.
5. Check the run, tag commit and Release assets. Download the installer and
   manually verify both installation scopes, shortcuts, recording and text insertion
   on Windows, including upgrades of existing current-user installs.

The installer uses Tauri's built-in NSIS `installMode: "both"` page: current user
or all users. This mode requests administrator access even for current-user
installation. All-users installation shares binaries, while each Windows user
retains separate settings, API keys and history. MSI is not built or published
starting with v0.2.4; the already published v0.2.3 assets remain unchanged.

## Pipeline and repository settings

- GitHub-hosted `windows-2025`, Node.js 22, Rust stable and MSVC/Windows SDK.
  Actions are pinned to verified stable release commits; review pins when upgrading.
- Version and duplicate-tag checks run before dependency installation/build.
  An existing tag skips publication without changing that tag or any assets.
  A lower version, inconsistent manifest/lock or orphaned release fails.
- Frontend tests, strict i18n and locked Rust tests must pass. One Tauri release
  build runs TypeScript/Vite via `beforeBuildCommand` and packages only NSIS.
  ESLint is excluded: ESLint 10 currently has no compatible flat config in this repo.
  Its absence is not a successful lint result.
- Exactly one NSIS installer must exist, be nonempty and match the
  product/version/x64 name returned by Tauri. Additional installers, including MSI,
  are rejected. The publish job rechecks SHA-256 after artifact transfer.
- Build has `contents: read`; only publish has `contents: write`. Both use the
  built-in `GITHUB_TOKEN`; no PAT or certificate secret is required. Repository
  **Settings → Actions → General** must allow these actions and job-level write
  permission. A default read-only workflow token is compatible with this override.
- Repository-wide release concurrency queues publication with
  `cancel-in-progress: false`. No job may replace an existing tag or asset.
- Recommend protecting `release`: require PRs, prohibit force-push/deletion,
  and require the repository's PR validation checks when available. The release
  workflow itself runs after merge and cannot serve as a required PR check.
  Do not require manual environment approval for publication.
- Verified release assets are retained as workflow artifacts for 14 days. Runner
  logs contain build/test diagnostics only; do not add private audio, credentials
  or local settings to the workflow or release assets.

## Failed publication

Test, build and package verification failures cannot create a tag or release.
Publication first reserves a new tag using the tested commit SHA; creating an
existing ref fails rather than overwriting it. The release is created with
`draft=false` and `prerelease=false`, then assets are uploaded without `--clobber`.
GitHub release creation and asset upload are separate API operations, so assets
may appear gradually during publication. A caught upload/verification failure
deletes only the release created by that run and leaves the tag reserved.

If publication is interrupted, or release creation/cleanup fails, inspect the
run and tag/release before recovery. Do not blindly rerun: the existing tag will
skip. Prefer fixing the cause and releasing a higher version; remove an incomplete
release/tag only after confirming its ownership and state. Existing successful
releases are never modified automatically.

## Signing and licenses

The first CI installers are **unsigned**. Windows SmartScreen may warn about an
unrecognized publisher. Code signing needs a separately configured certificate;
it does not enable automatic app updates.

Preserve AGPL-3.0 attribution and corresponding source access. The existing
LAME/LGPL-3.0 static-linking notices and redistribution obligations in
`THIRD_PARTY_NOTICES.md` remain applicable. License/source links and both notice
files are included in each public release. Publication has no separate legal
approval gate, as decided by the project owner.
