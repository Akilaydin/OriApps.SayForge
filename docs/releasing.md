# Releasing SayForge

Development goes into `main`. Only a push to the long-lived `release` branch runs
`.github/workflows/release.yml`; pushes to `main`, tags and PRs do not publish.
Successful CI publishes a public, non-prerelease GitHub Release automatically.
There is no draft or approval step. Signed releases support an optional in-app updater.

## Prepare a version

1. Merge the reviewed application changes into `main`; update `CHANGELOG.md` when needed.
2. Open and merge a PR from `main` into `release`. The release workflow chooses the
   next stable patch above existing stable tags/releases automatically when the
   checked-in version is already reserved. A deliberately prepared higher version
   (for example a major/minor release) is used as-is; manifest versions must agree.
3. CI synchronizes the five manifest/lock version fields and commits only those
   files to `release` with a source-merge SHA marker. It builds and publishes that
   prepared commit. The `main` branch is not modified automatically. Bot pushes use
   `GITHUB_TOKEN`, so they do not recursively trigger the push workflow. Re-running
   the original workflow reuses its prepared commit/version, including after a
   failed build or successful publication. No second version is allocated by a retry.
4. Follow **Actions → Windows release**. After tests, packaging and verification,
   CI creates `v<version>` at the exact tested prepared commit and publishes
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
- Version preparation and duplicate-tag checks run before dependency installation/build.
  Preparation has `contents: write` and a full-history checkout. It rejects a dirty
  checkout, stale source merge, unexpected prepared parent/files, mismatched versions
  and failed remote reads/pushes; it never force-pushes. Concurrent promotions that
  advance `release` before preparation must run their own current-commit workflow.
  An existing tag skips publication without changing that tag or any assets.
  Inconsistent manifest/lock values and an orphaned selected release fail. Stable
  orphaned tag/release versions are reserved when selecting the next patch.
- Frontend tests, English UI/installer checks and locked Rust tests must pass. One Tauri release
  build runs TypeScript/Vite via `beforeBuildCommand` and packages only NSIS.
  ESLint uses the repository flat configuration and runs before the frontend tests.
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
- Build has `contents: read`; version preparation and publish have `contents: write`. Both use the
  built-in `GITHUB_TOKEN`; no PAT or Windows certificate secret is required. **Two
  Actions secrets** provide the updater private signing key/password as described
  below. Repository
  **Settings → Actions → General** must allow these actions and job-level write
  permission. A default read-only workflow token is compatible with this override.
- Repository-wide release concurrency queues publication with
  `cancel-in-progress: false`. No job may replace an existing tag or asset.
- Promote application changes through PRs and prohibit force-push/deletion of
  `release`. Branch rules must permit the version-preparation job's normal push
  of its metadata commit; a mandatory PR rule without an appropriate bot exemption
  blocks automatic preparation. `main` remains unchanged by the bot and keeps its
  PR contribution workflow. The release workflow runs after promotion and cannot
  serve as a required PR check. No manual publication environment approval is needed.
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
skip. Prefer fixing the cause and promoting a new source commit (which allocates a higher version); remove an incomplete
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
