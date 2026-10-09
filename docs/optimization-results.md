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

## 10. PCM IPC measurements and limited optimization

Measured real Windows WebView2/Tauri IPC in an isolated hidden window, inert embedded HTML,
separate profile/identifier, identical protected browser arguments and synthetic PCM only.
Installed API forwards typed arrays as raw bodies; native `Request`/`InvokeBody::Raw` was
tested directly. No recording, cloud request, app settings or credentials are accessed.

Decision: retain the current JSON/Base64 transport and buffer copies. Replace its inner
per-byte string concatenation with bounded `String.fromCharCode(...chunk)` at 8192 bytes,
reusing the former ASR test pattern. This is a four-line deletion and one-line replacement.
Raw binary is faster, particularly at 300 seconds, but requires new metadata parsing and
changing all native adapters that currently accept Base64. That larger refactor is deferred.

Three trials per duration/mode; table shows medians. Stop starts after accumulated block
copies; includes merge/encoding/IPC through native command entry. Native decode is separate.
Cross-clock timestamps use JS timeOrigin + performance.now and Windows system time; allow
about millisecond precision. Debug Rust, no HTTP/MP3/inference. This is a harness measurement,
not observed PTT latency in the production app. Native length/checksum validate delivery.

| PCM seconds | PCM bytes | Base64 bytes | Old/new/binary stop→Rust ms | Old/new encoding ms | Base64 decode ms (new) |
| --- | --- | --- | --- | --- | --- |
| 5 | 160000 | 213336 | 7.165 / 9.830 / 3.209 | 1.3 / 4.1 | 1.726 |
| 30 | 960000 | 1280000 | 51.692 / 53.773 / 15.194 | 22.8 / 22.7 | 9.629 |
| 60 | 1920000 | 2560000 | 112.268 / 103.753 / 27.642 | 58.8 / 44.7 | 17.975 |
| 300 | 9600000 | 12800000 | 520.076 / 457.686 / 132.173 | 309.0 / 205.3 | 89.477 |

Largest reported JS heap after a 300-second request: old 446.8 MB, new 128.6 MB,
binary 68.1 MB. `performance.memory` is coarse and GC-dependent, not a peak/private-memory
guarantee. Sampled total working sets for the harness process tree: 1056.1 / 757.6 / 647.0 MB;
shared pages can be counted more than once. Whole cold-fixture CPU totals: 2640.625 /
968.750 / 1812.500 ms; startup and observer timing make these unsuitable as per-request
CPU comparisons. Small-duration timing differences are noisy; the defensible benefit of
the small change is lower temporary heap and faster long-input encoding.

Raw measurements: [audio-ipc-windows.json](benchmarks/audio-ipc-windows.json). Reproduce
from repository root with `powershell -File docs/benchmarks/run-audio-ipc.ps1`; it compiles
tests only, launches hidden fixtures and saves JSON/metrics under `.git`.
Validation: 393 frontend tests (including exact bytes for five minutes), 117 Rust tests,
TypeScript and `git diff --check` passed; Windows benchmark passed separately. Existing
cancel/late-response/AI/fallback tests pass. No binary production command was introduced.

## 11. Home and themes evaluation

Keep Home and all three themes. Home is the root route and Settings-close destination,
refreshes the configured hands-free shortcut, and follows App's onboarding gate. Tray opening
shows the existing main window without replacing its current route; About has its own event
route. Deleting Home would change these navigation expectations for little reduction.
Claude is a data-only theme using the same renderer/selector as light/dark; keeping it
preserves saved preferences. No alternate renderer/dependency can be removed with it.

Measured source footprint and isolated esbuild minification + gzip (not a release bundle):
Home 61 lines / 1993 source bytes / 1336 minified / 628 gzip; Claude 69 lines / 2082 source
bytes / 1595 minified / 580 gzip. Combined isolated compressed cost is about 1.2 kB;
shared-bundle compression/tree shaking can change this estimate. No full build was run.

Small compatibility fix: registry lookup now excludes inherited object keys; `constructor`,
`toString`, `__proto__`, unknown and retired teal IDs reliably fall back to light. Initialization
does not rewrite old settings. Fresh default is explicitly light, matching existing fallback.
Validation: 404 frontend/theme tests, TypeScript/i18n and `git diff --check` passed; route/onboarding/tray
call chains reviewed without behavior changes. Live first-run/navigation/theming remains
unverified. Physical tray/prewarm behavior is untouched.

## 12. Legacy ZIP restore evaluation

Keep the confirmed legacy ZIP import. Accepted format: `kind: full`, version 1,
`backup.json`, optional audio entries. It restores archived settings, prompt presets,
app rules, history (including legacy metadata), corrections, feedback and matching audio;
rewrites audio basenames into the current directory. Omitted collections and unrelated
audio remain. Retired model entries are ignored. Settings-only imports still exclude
history/audio; their preservation test passes. No full-ZIP export was restored.

Before this task, the native entry point/implementation occupied 60 lines / 2518 bytes,
with a shared 14-line path-rewrite helper. UI uses one legacy-restore action in the existing
file-picker/confirmation/import flow. Removing it would save this small source surface,
but cannot remove a dependency: diagnostics still creates and reads ZIPs using `zip` 0.6.6
with deflate (`byteorder`, `crc32fast`, `crossbeam-utils`, `flate2`). Exact binary reduction
was not measured because no full application build was run; dependency reduction is zero.

Options reviewed: retain the in-app path (smallest migration/support burden); move it into
a one-time tool (requires a separate distribution/versioning/testing path while diagnostics
still retains ZIP); remove it (strands historical history/audio because settings-only JSON
cannot replace full restore). Keep it until a separately agreed supported migration path
exists. There is no installed-user telemetry or real archive sample, so usage prevalence
is unknown. Removal must explicitly cover history/audio and communicate the transition.

Safety fixes within retained restore: reject traversal, symlinks, Windows special names,
duplicate manifests and flattened/case-colliding audio names; validate JSON shapes before
writes. Limits are 64 MiB JSON, 512 MiB per audio file, 8 GiB each for ZIP file/extracted
audio total and 100,000 entries. Audio streams to staging with declared/actual-size and CRC checks; its entire
contents are no longer buffered into a Vec. These caps intentionally reject oversized
archives without modifying user data; originals remain available for an agreed migration.
Settings and all five collections reuse existing SQL within one transaction. Displaced
audio is retained until database success and restored on ordinary installation/SQL errors.
If rollback itself fails, recovery files are retained and their directory is reported.

Validation: 125 Rust tests passed, two benchmarks intentionally ignored in the normal
suite. Eight new synthetic ZIP tests cover all legacy collections/metadata, nested audio,
unrelated-file preservation, SQL uniqueness failure after prior collection writes,
filesystem failure after a prior overwrite, unsafe names/history paths, symlinks, case/path
collisions, duplicate manifests, oversized metadata, bad CRC/actual-size mismatch, invalid
versions and malformed collections. Tests use isolated temporary SQLite/audio directories.
Existing settings-only history-preservation tests pass. `git diff --check` passed.
No real backup was imported and no user database/audio/model was modified.
Rollback is not atomic across process crashes/power loss; forced termination and recovery
failure remain unverified. New limits do not claim compatibility with arbitrarily large ZIPs.

## Completion and validation

All 12 tasks processed sequentially on their own `codex/` branches, with self-review,
relevant checks and merge/push to main before marking Obsidian tasks done. Tasks 10–12
retain Base64 IPC, Home/Claude and legacy ZIP support where removal was not
justified; their measurements and decisions are recorded above.

Latest applicable checks: 404 frontend tests in 40 files, 125 Rust tests with two ignored
benchmarks, TypeScript, strict i18n and `git diff --check` passed. Rust audio-encoding and
isolated Windows IPC benchmarks were also run explicitly during their respective tasks.
Frontend was last checked after task 11; task 12 changes only native restore and docs.
No full app/release build, new provider, streaming transport or installer change was made.

## Remaining checks

ESLint remains blocked by its existing ESLint 10/configuration mismatch.
Unit tests do not establish physical microphone, actual insertion or live-provider behavior.
The `--ignore-certificate-errors` flag, WebView tray, overlay prewarm, WAV support
and LAME remain protected throughout this stage.
