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

## Remaining checks

ESLint remains blocked by its existing ESLint 10/configuration mismatch.
Unit tests do not establish physical microphone, actual insertion or live-provider behavior.
The `--ignore-certificate-errors` flag, WebView tray, overlay prewarm, WAV support
and LAME remain protected throughout this stage.
