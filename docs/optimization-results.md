# SayForge optimization results

Started: 2026-10-09. Baseline: `c135eece50415952b050bc6e6f0811b03b56937c`.
Tasks run sequentially on separate branches, with tests before merge/push.
Full application builds are excluded from this stage.

## 1. Streaming and realtime remnants

Removed the live-caption setting/preview, retired provider link, partial-ASR callback,
streaming options/state/layouts, and streaming-vs-buffered hotword presentation.
The capability commands now return the buffered delivery and client limit only.
Existing SQLite settings/data are retained; the old streaming key is inert.
Normal overlay dimensions, microphone hints, warnings, cards, cancellation and native
prewarm/show/hide/recovery behavior are preserved.

Validation: 379 frontend tests and 107 Rust tests passed; TypeScript, strict i18n
and `git diff --check` passed. Regression tests cover ignored legacy streaming
payloads, microphone-hint bounds across warning updates, and waiting-phase reset.
Live Windows microphone/PTT/insertion checks remain unverified.

## 2. CSP and camera permissions

Added separate release/dev CSPs for bundled assets, PCM worklets, audio/image previews,
existing Google Fonts and Tauri IPC. Only dev permits inline React refresh and loopback
HMR. Cloud API calls remain native; no broad remote connect source was added.
Camera is explicitly denied, microphone remains allowed. All global browser flags are unchanged.
Rust: 109 tests passed, including actual Tauri config parsing, permission decisions and
protected browser arguments. `git diff --check` passed. Runtime dev/release WebView,
microphone and all-window CSP smoke checks remain unverified; no release build was run.

## 3. ASR protocol detection

Reused the stable error envelope with actual HTTP/network classification. Automatic protocol
fallback now requires a known route/payload incompatibility; 401/403/429/5xx, network/timeout,
ambiguous errors and 415 stop immediately. Explicit selection bypasses fallback. Cached choices
are invalidated after incompatibility, without duplicate protocol attempts. No persistent cache
was added; its metadata/invalidation/SQLite costs are not justified at this stage.
Prompt-field retries are limited to 400/422. ASR error bodies and private endpoints are not logged.
Local socket tests check exact attempts, explicit selection, cache reuse/invalidation, payload
shape fallback and actual timeout. Live gateways remain unverified.
Validation: 115 Rust tests and `git diff --check` passed.

## 4. MP3-first Cloud API

New profiles default to MP3; missing/migrated codec settings keep WAV. Multipart and
standard chat share the existing LAME encoder, executed on blocking workers including
connection tests. Legacy chat remains WAV. Payload tests verify filenames/MIME, standard
chat format and legacy data URLs. A rejected MP3 requires explicit WAV selection.

Measured on synthetic 16 kHz mono sine audio in Rust debug tests, one run per cell.
Upload fixture replies immediately after consuming the body; its throttled read loop
approximates 256,000 bytes/s. Native total includes decode/encoding/request, excludes
recording/UI/settings/real ASR inference. Fast loopback can favor WAV. Encoding varies
between runs; these figures are measurements, not production latency guarantees.

| Audio seconds | WAV/MP3 bytes | WAV/MP3 encoding ms | Loopback native ms | Throttled native ms |
| --- | --- | --- | --- | --- |
| 8 | 256044 / 63648 | 0.147 / 39.121 | 16.943 / 50.430 | 1022.056 / 287.635 |
| 30 | 960044 / 239616 | 0.333 / 175.327 | 20.169 / 203.337 | 3852.496 / 1181.106 |
| 60 | 1920044 / 479808 | 0.537 / 463.050 | 40.104 / 418.519 | 7714.369 / 2335.825 |

Multipart body adds 735 WAV / 736 MP3 bytes in this fixture. Reproduce with
`cargo test --manifest-path client/src-tauri/Cargo.toml benchmark_cloud_audio_formats -- --ignored --nocapture`.
No saved endpoint/profiles were configured locally; Russian ASR quality remains unverified.
Validation: 379 frontend and 116 Rust tests passed (benchmark ignored by default and
passed separately); ffprobe verified MP3 decoding, TypeScript/i18n/diff checks passed.

## 5. ASR configuration before stop

One asynchronous settings read starts with each recording. SQLite reads a consistent
transaction; typed catalog parsing builds all fields from the selected profile together.
Flat legacy settings remain a fallback. No startup await, extra network call, schema or
stored setting is added. Current-run settings failures are sanitized; stale settings/API
completions cannot submit or insert text. Hotwords/editor context remain start snapshots.

Controlled Vitest comparison against task-4 code used synthetic PCM, nine sequential
settings reads before vs one prepared snapshot after, a requested 2 ms mock delay per
read, and an immediate synthetic cloud reply. Windows timer scheduling amplified the
mock delay. Measured stop-to-completion: 8 s audio 155.066 → 32.410 ms; 30 s audio
165.663 → 69.353 ms. These include PCM merging/Base64 and callback overhead; they are
not measured WebView/SQLite or live stop-to-HTTP timings. Those remain unverified.
Validation: 384 permanent frontend tests passed across full/focused checks, plus the temporary benchmark;
116 Rust tests passed; TypeScript and `git diff --check` passed.

## 6. Shared ASR testing

Both settings test paths share WAV validation, PCM encoding and native request logic.
RIFF chunks are parsed rather than dropping 44 bytes blindly; invalid rate/channels,
sample format, empty/odd/truncated data fail before submission. Configuration construction
is shared with recording. Explicit draft tests never read/overwrite saved credentials or
availability checks; active tests read the saved snapshot. Playback/resource are retained.
Synchronous locks prevent duplicate Test calls; generation/mount guards discard stale UI
results and avoid starting requests after a late fixture load on an unmounted UI.
Validation: 388 frontend tests passed across full/focused checks; TypeScript/i18n and
`git diff --check` passed. Fixture/parser/payload/error tests use synthetic data.
React click/unmount interaction and live-provider smoke checks remain manual/unverified.

## 7. Dictionary simplification

Removed the model/provider support table and its independent capability/settings reads.
The remaining notice uses the same complete active configuration as recognition, refreshes
after protocol detection/settings changes, and rejects stale lookup responses. It explains
chat context vs multipart punctuation prompts and retains any client-limit warning.
Removed the obsolete AI hotword-switch advice; local spacing and replacements still work
with AI off. Categories/search/editing/sorting/export, text formatting, stored dictionaries
and `/hotwords` routing are unchanged. No user-data migration was introduced.
Validation: 388 frontend tests, TypeScript/i18n and `git diff --check` passed; native ASR capability
branches were already covered in tasks 1/3. Interactive Dictionary smoke remains unverified.

## 8. English locale and diagnostics cleanup

Locale reduced from 1074 to 603 keys: 471 reviewed unused entries removed, covering
retired server/local/realtime, feedback, model/update/audio screens, personalization,
provider comparisons and obsolete backup/config-transfer presentation. Stored settings,
profiles, history and legacy restore behavior are untouched.

`node client/scripts/audit-i18n.mjs` inventories all TypeScript string literals, templates
and dotted-prefix concatenations, plus native Rust references. It lists opaque dynamic
calls and candidates without deleting anything. Reviewed all 26 dynamic calls: sidebar,
settings/format/microphone option maps, history display-name maps, shortcut maps,
protocol templates, Dictionary message factories and conditional overlay/tray labels.
Their keys are literal entries or template-covered families. Post-cleanup: 603 referenced,
zero candidates and zero missing literal calls; TypeScript verifies typed maps as well.

Translated 209 test/suite titles and native/TS assertions, source-parser errors and stale
provider commentary. Remaining CJK is deliberate: localized Windows audio route matching,
microphone fixtures, Unicode settings/error-envelope round trips, privacy probes and
multilingual overlay text. None supplies an English UI diagnostic or comment.
Validation: 388 frontend / 116 Rust tests, TypeScript, strict i18n, AST inventory and
`git diff --check` passed. Runtime visual checks remain unverified.

## 9. Explicit Windows autostart

Fresh installs keep autostart off. Existing enabled registrations alone get the historical
`--minimized` argument migration, without disabling first. Disabled/deleted registrations
stay disabled. String/boolean flags are accepted; failed OS reads/registration do not mark
migration done. Existing stored choices are preserved; only the fresh seed default changes.
UI reads OS state, disables duplicate changes while pending, verifies readback and shows
an error/retry when a write/read fails or the OS disagrees. No optimistic success remains.
Installed auto-launch 0.5.0 source confirms `enable()` overwrites the existing Run value.
Validation: 392 frontend / 117 Rust tests, TypeScript/i18n and `git diff --check` passed.
Fresh/legacy/disabled flags, denied reads/writes and inconsistent readback are covered.
Actual registry/Windows sign-in and tray startup smoke remain unverified; no user startup
registration was changed during testing.

## Remaining checks

ESLint remains blocked by its existing ESLint 10/configuration mismatch.
Unit tests do not establish physical microphone, actual insertion or live-provider behavior.
The `--ignore-certificate-errors` flag, WebView tray, overlay prewarm, WAV support
and LAME remain protected throughout this stage.
