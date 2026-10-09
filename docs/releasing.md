# Releasing SayForge

Development goes into `main`. Only a push to the long-lived `release` branch runs
`.github/workflows/release.yml`; pushes to `main`, tags and PRs do not publish.
Successful CI publishes a public, non-prerelease GitHub Release automatically.
There is no draft or approval step. Signed releases support an optional in-app updater.

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
   **SayForge v<version>** with one NSIS `.exe` installer, its `.exe.sig`,
   `latest.json`, `SHA256SUMS.txt`, `LICENSE` and `THIRD_PARTY_NOTICES.md`.
   GitHub also provides corresponding source archives.
5. Check the run, tag commit and Release assets. Download the installer and
   manually verify both installation scopes, shortcuts, recording and text insertion
   on Windows, including updater-driven upgrades of existing current-user and all-users installs.

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
- Frontend tests, English UI/installer checks and locked Rust tests must pass. One Tauri release
  build runs TypeScript/Vite via `beforeBuildCommand` and packages only NSIS.
  ESLint is excluded: ESLint 10 currently has no compatible flat config in this repo.
  Its absence is not a successful lint result.
- Exactly one NSIS installer must exist, be nonempty and match the
  product/version/x64 name returned by Tauri. Additional installers, including MSI,
  are rejected. The bundle produces a matching `.exe.sig`; `latest.json` embeds
  that signature and an exact release asset URL for `windows-x86_64`. The publish
  job validates all six expected assets and rechecks SHA-256 after transfer.
- A dedicated [Rust signature verifier](../.github/tools/updater-verifier/src/main.rs)
  reads `plugins.updater.pubkey` from the checked-out Tauri config and uses
  Tauri's own Minisign verification algorithm to check actual installer bytes
  against `.exe.sig`. Both the build stage and the publish stage run it, **before
  tag creation**. The verifier is passed between jobs as a private workflow
  artifact, never uploaded to the public release; any missing verifier, malformed
  signature or valid signature from a different key blocks publication.
  Regression fixtures contain only synthetic data, public keys and signatures,
  never private keys. `release` guard tests run after Rust toolchain setup on
  new versions; pushes for existing tags skip the entire build and test path.
- Build has `contents: read`; only publish has `contents: write`. Both use the
  built-in `GITHUB_TOKEN`; no PAT or Windows certificate secret is required. **Two
  Actions secrets** provide the updater private signing key/password as described
  below. Repository
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
GitHub release creation and asset upload are separate API operations. Installer,
signature, checksums and notices are uploaded first; the `latest.json` discovery
manifest is uploaded **last**, once its referenced asset has been uploaded.
A caught upload/verification failure
deletes only the release created by that run and leaves the tag reserved.

If publication is interrupted, or release creation/cleanup fails, inspect the
run and tag/release before recovery. Do not blindly rerun: the existing tag will
skip. Prefer fixing the cause and releasing a higher version; remove an incomplete
release/tag only after confirming its ownership and state. Existing successful
releases are never modified automatically.

## Signing and key recovery

Tauri 2 updater signatures are mandatory and **separate from Windows code
signing**. Generate a unique keypair once with `npm run tauri signer generate --
-w <secure-path> -p <password> --ci` from `client/`. Embed the public `.pub` key
**contents**, not its file path, in `client/src-tauri/tauri.conf.json` under
`plugins.updater.pubkey`. Do not regenerate the key for subsequent releases:
installed builds will trust the original public key.

Store the **encrypted private key contents** as GitHub Actions repository secret
`TAURI_SIGNING_PRIVATE_KEY` and its passphrase as
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The secrets are exposed only to the Windows
release build steps; they must never enter source control, release assets or
logs. A missing secret or signature fails the build; the release is not published.

Keep an **off-machine encrypted backup of the private key and a separately
recoverable passphrase**. A copy of a password protected only by the Windows
account's DPAPI is not an off-machine backup and may be unreadable after
reinstallation. Losing either the signing key or its password prevents future
in-app upgrades of already installed versions without a manual transition.

Starting from the first release with this updater, each subsequent **higher
stable version** may be installed from the app. Already released `v0.2.4` and
older versions do not know how to check for updates; users must install the first
signed-updater-enabled release manually. Never modify old tags or assets.

## Windows code signing and licenses

The first CI installers are **unsigned**. Windows SmartScreen may warn about an
unrecognized publisher. Windows Authenticode signing needs a separately configured
certificate and is not supplied by the Tauri update signing key.

Preserve AGPL-3.0 attribution and corresponding source access. The existing
LAME/LGPL-3.0 static-linking notices and redistribution obligations in
`THIRD_PARTY_NOTICES.md` remain applicable. License/source links and both notice
files are included in each public release. Publication has no separate legal
approval gate, as decided by the project owner.
