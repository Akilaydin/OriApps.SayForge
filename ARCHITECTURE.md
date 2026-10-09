# Architecture

Technical reference for the current SayForge implementation. Product behavior belongs in `PRODUCT.md`.

## System

- One Windows desktop application: **Tauri 2 + Rust + React + TypeScript + Vite**.
- React manages the UI, microphone capture, recording lifecycle and text processing.
- Rust handles Win32 integration, persistence and cloud HTTP calls.
- Speech mode: `cloud_api`. Retired `local`/server values normalize and persist as `cloud_api` at frontend startup.
- Optional AI refinement uses an OpenAI-compatible endpoint and a single prompt; Ollama, preset shortcuts, per-app rules and personalization statistics are inactive.
- SQLite persists settings and history. The app uses `com.oriapps.sayforge` as its identity.
- Updates are manual through GitHub Releases; no updater service, installer commands or notification window are bundled.

## Dictation flow

```text
Global hotkey / UI
    -> Rust keyboard and active-window context hooks
    -> RecorderOrchestrator
    -> microphone capture (16 kHz mono PCM)
       -> CloudAPIProvider -> Rust ASR adapter -> configured API
    -> optional AI refinement and text transforms
    -> text history
    -> captured Windows text target
       -> native insertion, or copyable fallback card
```

## Component ownership

Paths below are relative to `client/`.

### React / TypeScript (`src/`)

- `services/recorder/RecorderOrchestrator.ts` — state, PTT/hands-free events, session IDs, cancellation, timeouts and final results.
- `services/audio.ts` — `getUserMedia`, AudioWorklet with fallback, resampling and PCM frames.
- `services/transcription/` — provider interface, mode selection, buffered cloud delivery and AI execution policy.
- `services/aiPrompt.ts` — a single editable AI prompt and legacy custom-prompt migration. `services/contextAware.ts` preserves bounded editor context.
- `services/textPostProcess.ts` and `textReplacement.ts` — configurable output transformations.
- `services/recorder/OverlayService.ts` and `PasteService.ts` — progress/recovery UI and native insertion requests.
- `services/store.ts` and `services/bridge.ts` — access to Tauri commands and persisted state.
- `services/debugLog.ts` — bounded runtime diagnostics mirrored to native logs; no experimental session/audio viewer or separate PTT laboratory hook.

### Rust (`src-tauri/src/`)

- `main.rs` — Tauri setup, commands, single-instance behavior, tray and windows.
- `keyboard/`, `context/`, `commands/paste.rs` — global input hooks, foreground-target probing and Win32 insertion.
- `providers/` — OpenAI-compatible HTTP ASR, optional AI cleanup and capability reporting.
- `storage/` and `commands/storage.rs` — SQLite migrations, settings and history.
- `commands/backup.rs` — local exports/imports; no WebDAV client or background backup scheduler.

## Storage

- SQLite: `%LOCALAPPDATA%\com.oriapps.sayforge\sayforge.db`, using WAL and versioned migrations.
- `app_settings` holds JSON settings; `history_records` stores transcription records. Legacy prompt presets, app rules, corrections and feedback retain their existing tables for compatibility.
- Recording PCM lives only in the cloud provider buffer; no second archive buffer or audio retention cleanup runs. Older audio files remain on disk. Log cleanup still follows its retention setting.
- Settings JSON export/import excludes history and audio. Legacy selected settings and full ZIP imports remain compatible; preview tokens protect settings import confirmation. Retired settings and SQLite columns/tables remain intact. History favorites and statistics have no active UI; recording no longer updates statistics.

## Invariants

- Run IDs and cancellation must prevent late results from updating another recording or editor field.
- Probe and preserve the original edit target; provide fallback text when native insertion fails or is unconfirmed.
- Treat editor context as bounded, untrusted data. Do not replace selected text unless an AI edit was applied.
- Keep buffered ASR UI capabilities, protocol selection and Rust provider dispatch consistent. Retired streaming settings remain stored but are inert.
- Cloud ASR sends recorded audio; optional cloud AI refinement may transmit text/context. Retired model files/settings remain untouched.
- Preserve settings, SQLite schema migrations and the application data path.
- Main and overlay WebView2 windows must use consistent environment-level browser flags.

## ASR protocol selection

Explicit protocols bypass detection. Auto tries the cached protocol first, then each remaining
HTTP protocol once. Only structured route/audio-payload compatibility failures permit another
protocol; authentication, rate limit, network, timeout, 5xx, ambiguous 4xx and 415 stop immediately.
Successful endpoint/model choices are cached in-process and invalidated only by incompatibility.
No persistent cache was added: it would persist private endpoint metadata, require invalidation
across credential/provider changes, and add SQLite work to the path. Unknown gateway errors require
the user to choose a protocol explicitly. Diagnostic attempts include only protocol/count/status;
provider response bodies, model names and endpoint URLs are excluded from ASR failure/start logs.

## WebView content policy

Release CSP permits bundled resources and Tauri IPC, data/blob PCM AudioWorklet modules,
audio previews and diagnostic images. Inline styles are needed by React; Google Fonts
hosts remain allowed for the existing main-page font. Remote API requests run in Rust,
so the WebView has no general HTTP/HTTPS API permission. Objects, frames and forms are
blocked. Dev CSP additionally allows Vite's inline React refresh script and loopback HMR
on ports 1420/1421; custom `TAURI_DEV_HOST` needs an explicit matching dev CSP override.
Tauri's automatic bundled-script/style hashes and nonces remain enabled, as described in
[Tauri CSP guidance](https://v2.tauri.app/security/csp/).
WebView2 automatically allows microphone and denies camera; other permissions use the
browser default. Global browser flags, including `--ignore-certificate-errors`, are unchanged.

## Open questions

- Verified minimum Windows version.
- Release signing and update-channel design.
