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

## Remaining checks

ESLint remains blocked by its existing ESLint 10/configuration mismatch.
Unit tests do not establish physical microphone, actual insertion or live-provider behavior.
The `--ignore-certificate-errors` flag, WebView tray, overlay prewarm, WAV support
and LAME remain protected throughout this stage.
