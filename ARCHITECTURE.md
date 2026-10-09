# Architecture

`ARCHITECTURE.md` describes the current technical system. User-facing behavior and product scope belong in `PRODUCT.md`.

## Fixed decisions

### Runtime and deployment

- Windows desktop application based on **Tauri 2**, **Rust**, **React 18**, **TypeScript** and **Vite**.
- The React application and native functionality ship together as one desktop application. No separately deployed ASR or application server is required.
- Rust/Tauri owns OS-level integration, commands, persistence, HTTP/WebSocket provider adapters and local inference.
- React/TypeScript owns the UI, microphone capture pipeline, transcription orchestration, text processing and application settings flows.
- The app uses a single-instance Tauri plugin, a main window, a recording overlay and tray integration.

### Processing modes

- `cloud_api`: audio is sent directly from the desktop application to a user-configured ASR service.
- `local`: speech recognition runs on the user's machine with a downloaded GGUF model.
- Both modes can use optional, separately configured AI text refinement.
- Legacy `workMode=server` and unknown saved values normalize to `cloud_api`. There is no runtime Server Mode.

### Storage and identity

- SQLite via `rusqlite` is the persistent store, with migrations and WAL enabled.
- App ID: `com.oriapps.sayforge`; database: `%LOCALAPPDATA%\com.oriapps.sayforge\sayforge.db`.
- Recorded audio and application logs are stored in app-specific filesystem directories.
- Data from other application identities is never automatically imported or deleted.

### Release channel

- The Tauri updater plugin is disabled. Automatic check/download/install orchestration is not started by the app.
- Installation and updates remain manual until SayForge has a verified signed release and update channel.

## Runtime flow

```text
Windows hotkey / tray / UI
        |
        v
Rust keyboard hook + active-window context probe
        | Tauri events / commands
        v
RecorderOrchestrator (recording lifecycle and run ID)
        |
        v
Web Audio microphone capture -> 16 kHz mono PCM
        |
        +--> CloudAPIProvider -> Rust cloud ASR adapters -> remote API
        |
        +--> LocalProvider -> Rust local_transcribe -> GGUF inference
        |
        v
Optional AI refinement -> text transforms / replacements
        |
        +--> SQLite history + optional WAV audio archive
        |
        v
Captured Windows edit target -> native paste / insertion
        |
        +--> failure or unconfirmed insertion: copyable overlay card
```

### Recording lifecycle

- `client/src/services/recorder/RecorderOrchestrator.ts` owns state transitions, PTT and hands-free events, capture, timeouts, result handling, history and insertion decisions.
- `client/src/services/audio.ts` uses `getUserMedia`, Web Audio and an AudioWorklet, with a ScriptProcessor fallback. It resamples audio to 16 kHz mono PCM for ASR.
- `client/src/services/recorder/OverlayService.ts` manages recording, processing, warnings and recovery cards.
- Each recording has a run ID. Canceled or superseded runs must not publish late transcripts or write text into the editor.
- An empty or failed recognition result must not be treated as a successful insertion. Failure and recovery paths are first-class behavior.

### ASR provider abstraction

- `client/src/services/transcription/types.ts` defines the `TranscriptionProvider` interface and two `WorkMode` values.
- `client/src/services/transcription/index.ts` selects providers and migrates retired stored mode values.
- `CloudAPIProvider.ts` buffers PCM for file-style requests or forwards chunks for supported realtime sessions; streaming partials reach the UI through Tauri events.
- `LocalProvider.ts` extends `BufferedProvider.ts`, verifies that the selected model was downloaded, and invokes Rust local inference.
- `client/src-tauri/src/providers/registry.rs` dispatches cloud transcription and text refinement to Rust provider modules. The supported cloud catalog includes OpenAI, Groq, Gemini, OpenRouter and custom OpenAI-compatible endpoints.
- Custom OpenAI-compatible ASR supports transcriptions and chat-audio protocol variants; the standard `input_audio` path supports WAV and optional MP3 encoding. Not every provider supports streaming or the same hotword semantics.
- Connection tests, runtime dispatch and advertised provider capabilities must remain consistent when adding or changing a protocol.

### Local models

- `client/src-tauri/src/models/catalog.rs` lists NVIDIA Parakeet Unified EN and Nemotron 3.5 ASR GGUF models.
- `models/registry.rs` and `models/downloader.rs` manage model availability, downloads, integrity checks and model directories.
- `models/local_asr.rs` and `models/gguf_asr.rs` provide local recognition through `transcribe-cpp` with a Vulkan-enabled build.
- Model download/install is separate from the app binary. A configured local provider is not ready until the required model is present.

### Text refinement and application context

- `client/src/services/transcription/aiPolicy.ts` determines whether AI refinement is eligible for a run; `clientAiPolish.ts` invokes Rust `cloud_polish` and falls back when configuration is missing or the call fails.
- `client/src/services/personalization/promptRouter.ts` selects presets and per-application prompt rules using detected application context.
- `client/src/services/contextAware.ts` bounds editor context, treats captured text as untrusted data and protects selections when the edit was not explicitly applied.
- `client/src/services/textPostProcess.ts`, `textReplacement.ts` and related services apply configured output transformations.
- Local speech recognition plus enabled cloud AI refinement is **not** an entirely offline workflow.

### Windows context and insertion

- `client/src-tauri/src/keyboard/` handles native keyboard hooks; `commands/shortcuts.rs` handles shortcut registration and related controls.
- `client/src-tauri/src/context/` monitors the foreground Windows application. `commands/paste.rs` probes the target and performs native text insertion.
- `client/src/services/recorder/PasteService.ts` passes the captured target details to Rust so focus changes after key release do not silently redirect text.
- An uneditable target, failed paste or unconfirmed insertion uses a copyable fallback card rather than discarding the transcript or blindly retrying into another field.
- The main and overlay windows share a WebView2 user-data directory. Browser flags must be configured globally, not separately per window.

### Persistence, exports and backups

- `client/src-tauri/src/storage/mod.rs` applies SQL migrations and exposes settings, history and collection operations through `commands/storage.rs`.
- `app_settings` stores JSON settings. `history_records` stores searchable metadata and JSON records; `manual_corrections`, `feedback_queue`, `prompt_presets` and `app_prompt_rules` have separate tables.
- Audio files are stored separately and referenced from history records by path. Audio/log retention cleanup runs on startup according to saved retention settings.
- `client/src/services/store.ts` and `services/bridge.ts` form the frontend's persistence/command boundary.
- `commands/backup.rs` handles local settings/full export and import. `commands/webdav.rs` supports user-configured WebDAV backup/restore; `features/backup/autoWebdavBackup.ts` schedules that opt-in behavior.
- Config-only export does not include audio/history. Local full export/import and restoration require explicit user action; scheduled WebDAV backups require the user's opt-in.

## Repository layout

```text
.
├── client/
│   ├── src/                    # React UI, state, audio, recording and ASR orchestration
│   │   ├── features/           # Settings, backup, updates, debug UI
│   │   ├── services/           # Audio, transcription, insertion, history and prompts
│   │   ├── overlay/            # Floating recording UI
│   │   └── i18n/locales/en.json
│   ├── src-tauri/
│   │   ├── src/                # Rust commands, Win32, inference, provider clients, SQLite
│   │   ├── icons/              # Installer and app icons
│   │   └── tauri.conf.json
│   └── package.json
├── docs/                       # README images and other project assets
├── ARCHITECTURE.md
├── PRODUCT.md
└── AGENTS.md
```

## Architecture invariants

- Keep the desktop runtime independent of any separately operated backend.
- Preserve compatibility with existing persisted settings, ASR profiles, prompt rules and history.
- Keep network requests explicitly tied to selected ASR/AI providers, model downloads or user-enabled backup actions.
- Never silently inject stale, empty or unconfirmed text into an unrelated Windows target.
- Preserve app-specific data isolation and the existing SQLite migration path.
- Do not activate unsigned automatic updates or silently migrate user data from another app.

## Open questions and known constraints

- Exact minimum supported Windows version and the verified hardware/driver matrix for Vulkan local inference are not documented.
- The production release-signing and SayForge update-channel design are pending.
- Some legacy compatibility helpers remain in the code; their removal must preserve stored-data and workflow compatibility.
