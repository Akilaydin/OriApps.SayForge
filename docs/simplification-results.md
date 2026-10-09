# SayForge simplification results

Date: 2026-10-09. Baseline: `13491766295382b2fa3c8d2b76f642ac26005f5c`.
The implementation was completed on sequential task branches and merged/pushed to `main`.
The release build used the application code at `928734aaa28fc33ae6dbdd91aa2d989cd15585e2`;
subsequent changes contain build documentation and test-only code.

## Resulting scope

SayForge keeps Cloud API dictation through configurable OpenAI-compatible HTTP endpoints,
optional AI cleanup with one editable prompt, hotwords, text replacements, safe text insertion,
copyable fallback, searchable text history/TXT export, local settings export/import, legacy ZIP
restore, diagnostics, About, WebView tray and the existing overlay prewarm.

Removed: legacy backend/updater infrastructure, experimental Debug/PTT/Studio screens,
WebDAV scheduling and transfer, vendor/realtime ASR implementations, local ASR/model management,
preset/app-rule personalization and statistics, audio history/archive/playback/reprocessing,
favorites UI and new full ZIP exports. Older settings, history, audio and downloaded models
are retained. Settings-only import does not overwrite history.

Identity remains `com.oriapps.sayforge`, database `sayforge.db`. SQLite migration SQL is unchanged.
Tray sources, native window/prewarm sources and `OverlayService.ts` are unchanged from baseline.
The `pcm_to_mp3` implementation is unchanged; LAME and its LGPL notice remain.

## Measurements

MiB means 1,048,576 bytes. Missing baseline measurements cannot establish a performance improvement.

| Metric | Baseline | Final |
| --- | --- | --- |
| Direct npm runtime dependencies | 17 | 12 |
| Direct npm development dependencies | 16 | 16 |
| npm lockfile dependency entries, all platforms | 322 | 317 |
| Direct Cargo normal dependencies, including Windows, excluding build dependency | 38 | 26 |
| Cargo lockfile package entries, all platforms | 688 | 649 |
| Tracked TS/TSX/Rust source files | 202 | 140 |
| Source lines | 52,613 | 31,070 |
| Frontend dist files/bytes | 20 / 1,052,367 | 13 / 655,488 |
| Release executable bytes | Not available | 16,859,136 (16.078 MiB) |
| NSIS installer bytes | Not available | 4,817,200 (4.594 MiB) |
| MSI installer bytes | Not available | 6,656,000 (6.348 MiB) |
| Local ASR DLL payload | Staging: 24 files / 87,339,768 bytes | Absent from both installer payloads |

Source count covers `client/src` and `client/src-tauri/src`, excludes TS `__tests__`
directories and includes inline Rust tests. Net reduction: 21,543 lines (40.95%).
The final compatibility test contributes 52 retained source lines.

Baseline `client/dist` was a stale existing artifact, not a new baseline build.
Its comparison with the freshly built dist shows 396,879 fewer bytes (37.71%),
but does not prove the same reduction between equivalent release builds.
No baseline release binary or installer was available.

The old 83.294 MiB ASR staging folder remains in the ignored development cache.
It is neither a packaged resource nor a runtime dependency. User model/audio folders were not cleaned.

Removed npm direct dependencies: fs/global-shortcut/process/updater Tauri frontend packages and
`fast-diff`. Removed Cargo direct dependencies: fs/process/updater plugins, `sha2`,
`futures-util`, `tokio-tungstenite`, `flate2`, `tar`, `bzip2`, `tokio-util`,
`silero-vad-crs`, `transcribe-cpp`. Dependencies still needed transitively remain;
for example the dialog plugin retains the Rust fs crate.

The recorder no longer duplicates PCM for archiving. At 16 kHz, mono, 16-bit PCM this removes
one buffer growing by 32,000 bytes/second (9.155 MiB at five minutes).
This is derived from the removed allocation, not a measured process RAM reduction.

## Validation

- Final frontend: 397 tests in 37 files passed; TypeScript and strict i18n checks passed.
- Final Rust: 109 tests passed, including SQLite v1 migration/reopen and data preservation.
- Recorder tests exercise cancellation during history writes, results overtaken by another run,
  history-write failure, non-editable target fallback and timeout-context expiration.
- Buffered cloud tests verify custom endpoint/model/MP3 configuration, stopped-run upload,
  cancellation/late responses and API errors. AI tests cover failures, timeout and cancellation.
- Existing shortcut, microphone routing, context handling and overlay lifecycle tests passed.
  Native synthetic MP3 encoding/payload tests passed.
- `npm ci --ignore-scripts` and relevant checks completed; `git diff --check` passed.
- One final `tauri build` completed frontend/Rust release build and both NSIS/MSI bundles.
- 7-Zip successfully tested NSIS. Its file list and the read-only MSI File table contain
  the app and synthetic `resources/test_en.wav`, with no GGML/Vulkan/local ASR DLLs.
  NSIS contains its own installer plugin DLLs; these are unrelated to local ASR.

Artifacts are local, under `client/src-tauri/target/release/`; they were not installed or published.
SHA-256:

- `sayforge.exe`: `dd3a8aa69ba1aca27d3806ca1f59369a5466dc2d0c7e3a65c2f0c6f9ebd3436a`
- `bundle/nsis/SayForge_0.2.2_x64-setup.exe`: `97e01a45c88088b63a6938425169cbbbcc25d9aa68ce53355159efcb20d5eb6d`
- `bundle/msi/SayForge_0.2.2_x64_en-US.msi`: `4229835c52196741a78cca44b4719787e536175e9a0d0c555d68f4f5a01f4f0b`

## Runtime sample and remaining checks

One release run used `--minimized` after confirming autostart had already been initialized.
A consistent SQLite backup was saved in the ignored target directory before launch.
The app was then stopped after sampling; no microphone recording or Cloud API call was initiated.

- SayForge working set: 36,818,944 bytes (35.113 MiB); private committed bytes: 9,449,472 (9.012 MiB).
- Nine-process tree, including eight WebView2 processes: working-set sum 645,603,328 bytes
  (615.695 MiB); private committed sum 355,848,192 bytes (339.363 MiB).
- Over 62.922 seconds, CPU time increased by 0.171875 seconds for the app and 0.40625 for
  the tree: 0.04035% of a machine with 16 logical processors.
- Working-set sums count shared pages more than once; private committed bytes are not resident RAM.
  This is one cached-profile sample, not a peak-memory or repeated performance benchmark.
- Win32 `WaitForInputIdle` succeeded after 274 ms. This measures native message-loop readiness;
  frontend readiness and first-dictation latency remain unmeasured.
- SQLite fingerprints before/after launch: no changes to existing setting values or the history,
  prompt, app-rule, correction and feedback tables. One new setting was added during startup.

Baseline RAM/CPU/startup measurements were unavailable; no before/after improvement can be claimed.

Physical microphone capture, global PTT/hands-free in other Windows apps, live paid Cloud ASR,
real clipboard/editor insertion and fallback copying, clicking tray controls, installed-app startup,
installer execution and restore through the actual UI remain manual checks.
Synthetic/unit tests and installer content inspection do not substitute for these checks.

Lint remains blocked by ESLint 10 requiring `eslint.config.*`, while the repository retains
`.eslintrc.cjs`; lint did not pass. This pre-existing tooling issue was not expanded into a refactor.
Current `npm audit --omit=dev` reports 14 affected dependency entries (10 high, 4 moderate).
Dependency upgrades/security remediation were outside the agreed orphan-dependency cleanup.

Configured commit signing could not find the private GPG key; Git tooling created unsigned commits.
Source merges and pushes succeeded.

Review order: app/settings entry points → recorder/provider/export call chains → Cargo/npm and
bundle resources → regression tests and this measurement report.

