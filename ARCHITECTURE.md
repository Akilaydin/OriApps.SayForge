# Architecture

Technical reference for the current SayForge implementation. Product behavior belongs in `PRODUCT.md`.

## System

- One Windows desktop application: **Tauri 2 + Rust + React + TypeScript + Vite**.
- React manages the UI, microphone capture, recording lifecycle and text processing.
- Rust handles Win32 integration, persistence, local inference and cloud HTTP calls.
- Speech modes: `cloud_api` (user-configured remote ASR) and `local` (downloaded on-device GGUF model).
- Optional AI refinement is independent of the speech engine.
- SQLite persists settings and history. The app uses `com.oriapps.sayforge` as its identity.
- Updates are manual through GitHub Releases; no updater service, installer commands or notification window are bundled.

## Dictation flow

```text
Global hotkey / UI
    -> Rust keyboard and active-window context hooks
    -> RecorderOrchestrator
    -> microphone capture (16 kHz mono PCM)
       -> CloudAPIProvider -> Rust ASR adapter -> configured API
       OR LocalProvider -> Rust GGUF inference
    -> optional AI refinement and text transforms
    -> history / optional audio archive
    -> captured Windows text target
       -> native insertion, or copyable fallback card
```

## Component ownership

Paths below are relative to `client/`.

### React / TypeScript (`src/`)

- `services/recorder/RecorderOrchestrator.ts` — state, PTT/hands-free events, session IDs, cancellation, timeouts and final results.
- `services/audio.ts` — `getUserMedia`, AudioWorklet with fallback, resampling and PCM frames.
- `services/transcription/` — provider interface, mode selection, buffered cloud delivery, local provider and AI execution policy.
- `services/personalization/` and `services/contextAware.ts` — presets, application-aware prompts and bounded editor context.
- `services/textPostProcess.ts` and `textReplacement.ts` — configurable output transformations.
- `services/recorder/OverlayService.ts` and `PasteService.ts` — progress/recovery UI and native insertion requests.
- `services/store.ts` and `services/bridge.ts` — access to Tauri commands and persisted state.
- `services/debugLog.ts` — bounded runtime diagnostics mirrored to native logs; no experimental session/audio viewer or separate PTT laboratory hook.

### Rust (`src-tauri/src/`)

- `main.rs` — Tauri setup, commands, single-instance behavior, tray and windows.
- `keyboard/`, `context/`, `commands/paste.rs` — global input hooks, foreground-target probing and Win32 insertion.
- `providers/` — OpenAI-compatible HTTP ASR, optional AI cleanup and capability reporting.
- `models/` — local GGUF model catalog, downloads, integrity checks and inference via `transcribe-cpp`/Vulkan.
- `storage/` and `commands/storage.rs` — SQLite migrations, settings and history.
- `commands/backup.rs` — local exports/imports; no WebDAV client or background backup scheduler.

## Storage

- SQLite: `%LOCALAPPDATA%\com.oriapps.sayforge\sayforge.db`, using WAL and versioned migrations.
- `app_settings` holds JSON settings; `history_records` stores transcription records. Prompt presets, app rules, corrections and feedback use dedicated tables.
- Audio files and logs reside in app-specific directories; cleanup follows retention settings.
- A settings-only export excludes history and audio. Full backups are a separate local operation. Retired WebDAV settings remain stored and included in settings exports for compatibility.

## Invariants

- Run IDs and cancellation must prevent late results from updating another recording or editor field.
- Probe and preserve the original edit target; provide fallback text when native insertion fails or is unconfirmed.
- Treat editor context as bounded, untrusted data. Do not replace selected text unless an AI edit was applied.
- Keep ASR UI capabilities, protocol selection and Rust provider dispatch consistent.
- Local ASR can work on-device, but enabled cloud AI refinement may transmit text/context.
- Preserve settings, SQLite schema migrations and the application data path.
- Main and overlay WebView2 windows must use consistent environment-level browser flags.

## Open questions

- Verified minimum Windows version and hardware/driver requirements for local inference.
- Release signing and update-channel design.
