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

## Remaining checks

ESLint remains blocked by its existing ESLint 10/configuration mismatch.
Unit tests do not establish physical microphone, actual insertion or live-provider behavior.
The `--ignore-certificate-errors` flag, WebView tray, overlay prewarm, WAV support
and LAME remain protected throughout this stage.
