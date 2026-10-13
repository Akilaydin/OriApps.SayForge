# Development CI

`Windows PR checks` runs for PRs into `main` and pushes to `main`. The trusted
`main` run builds both test and release dependencies so later PRs can restore
its cache. The release workflow uses the same keys and paths; GitHub still
isolates caches by branch, so a PR cache cannot seed `main` or `release`.

Keys include the runner image, Rust compiler, Cargo/compiler environment,
normalized manifests, Cargo configuration and lockfiles. Our package version
alone does not invalidate the dependency prefix. Cargo still validates build
fingerprints and rebuilds changed application code and resources.

Successful runs save a complete cache. Failed Rust/build/test runs save a
separate partial snapshot keyed by run ID and attempt. A partial snapshot is
restored only when no compatible complete cache exists; it never occupies a
complete cache key. Installer bundles, signatures and application executables
are excluded. Cancelled runs do not save partial snapshots.

Both workflows upload Cargo `--timings` HTML reports and cache/compiler/SHA
metadata as seven-day artifacts. Compare the same commit, compiler and profile;
include cache download/upload time when comparing complete job durations.

## Manual comparisons

The shared production/PR profile uses ThinLTO and eight codegen units. On the
same Windows/Rust 1.99 source, rebuilding only the application with dependencies
already compiled took 217.5 seconds with fat LTO/1, 71.5 with thin/8, and 77.4
with thin/16. EXE sizes were 19.06, 21.86 and 22.03 MB. These are single local
measurements, not end-to-end CI guarantees or evidence of runtime performance.
Thin/8 balances fast iterative builds with the smaller of the two thin binaries.

Dispatch `checks.yml` on a development branch using:

- `cache_mode=normal` to restore/save caches, or `cold` to bypass them.
- `profile=current` to use Cargo.toml, or `fat`, `thin-8`, `thin-16` for explicit
  release-profile experiments. These options also test the built EXE startup
  on a disposable Windows runner and synthetic MP3/WAV requests to a local mock.
- `probe_cache_failure=true` to deliberately fail after compiled Rust tests.
  Rerun normally at the same SHA to verify partial-cache recovery and promotion
  to a complete cache. The probe is never enabled by PR or main-push events.

These checks build without bundling, signing or publishing. They do not run
the installed app, use personal settings or make paid ASR calls.

Prepare code, focused local checks, documentation and a final diff review
before the first push. Check current-HEAD CI and assess Codex feedback before
merging; do not duplicate an already running review. Routine approved merges
need no additional owner confirmation.
