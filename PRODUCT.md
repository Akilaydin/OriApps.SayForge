# Product

`PRODUCT.md` is the source of truth for SayForge's user-facing behavior and current scope. Implementation detail belongs in `ARCHITECTURE.md`.

## Overview

SayForge is an open-source **Windows voice dictation application** maintained by OriApps. A user presses a global shortcut, speaks into a microphone, and gets recognized text inserted into the active application. It supports local speech recognition and direct use of cloud ASR providers, with optional AI-powered text refinement.

The product is a personal desktop writing tool, not a separate speech-recognition server. Users can bring their own cloud endpoint and API key instead of relying on a SayForge-hosted service.

## Current status and scope

SayForge is in a pre-release independent-brand transition. The desktop implementation exists, but a reviewed, signed SayForge release and trusted automatic update channel have not yet been published. Installation and updates are manual until then.

### In scope

- Windows desktop dictation into the currently targeted text field.
- Global push-to-talk, hands-free/toggle recording and configurable shortcuts.
- User-selectable microphone and recording/processing overlay with status and recovery actions.
- Two speech-recognition modes: **Cloud API** and **Local**.
- Cloud ASR profiles, including custom OpenAI-compatible endpoints and provider/model settings.
- Downloadable on-device English and multilingual speech-recognition models.
- Optional AI text cleanup, custom prompts, prompt presets and per-application prompt rules.
- Hotwords, text replacements, output formatting and optional context-aware editing of selected text.
- Local transcription history with audio playback, search and favorites; export and settings management.
- Configuration export/import, full backup/restore, and optional user-configured WebDAV backups.
- Windows tray controls, autostart settings and troubleshooting diagnostics.

### Out of scope for the current product

- A separately hosted SayForge ASR backend or Server Mode.
- A hosted user-account service, cloud synchronization account or built-in paid ASR subscription.
- macOS, Linux, browser and mobile builds.
- Meeting recording, system-audio capture, multiple speaker tracks or speaker diarization.
- A guarantee that text injection succeeds in every third-party Windows application.
- Automatic update installation before a verified SayForge release/signing process exists.

## Dictation interaction

1. Configure the speech engine and microphone, and choose a global shortcut.
2. Start recording with the push-to-talk or hands-free shortcut.
3. Speak; the overlay shows the recording state and, when supported, streaming transcript feedback.
4. Stop recording. SayForge transcribes the captured audio and optionally refines the result.
5. SayForge attempts to insert text into the captured editable target. If insertion is unavailable or cannot be confirmed, it presents the text in a fallback card for manual copying.

Short or silent recordings may produce no transcript. Canceling a run must not cause a late transcript to appear unexpectedly in another field. Text insertion depends on Windows focus, application control support and privileges.

## Speech recognition

### Cloud API mode

- Speech audio is sent directly to the provider selected by the user; a separate local backend is not needed.
- Available integrations include OpenAI, Groq, Google Gemini, OpenRouter and custom OpenAI-compatible endpoints.
- OpenAI-compatible configurations can use transcription and chat-audio protocols. The standard `input_audio` option uses WAV by default and can optionally send MP3 at 64 kbps mono.
- Realtime partial text is available only for supported streaming provider/model paths. Hotword delivery also depends on the selected protocol.
- Provider credentials, endpoints and models are configured by the user. Availability, cost and privacy policies are governed by the chosen service.

### Local mode

- Recognition runs on the user's device with a downloaded GGUF model.
- The currently supported catalog contains **NVIDIA Parakeet Unified EN** for English and **NVIDIA Nemotron 3.5 ASR** for multilingual dictation, including Russian.
- A model must be downloaded before it can be used. Inference compatibility and performance depend on the user's Windows hardware and drivers.
- Local ASR alone does not send audio to a cloud transcription service. **Enabling separately configured cloud AI cleanup can still transmit text and editor context to an AI provider.**

Only `cloud_api` and `local` are active modes. Stored preferences for the retired `server` mode are migrated to Cloud API, without deliberately clearing saved cloud credentials.

## AI refinement and personalization

- AI refinement is optional and uses a separately configured provider. Users can disable it without disabling speech recognition.
- Users can configure the system instructions/prompts used for refinement, select presets and apply application-specific prompt rules.
- Hotwords and deterministic text replacements can adjust recognition/output. Supported hotword delivery varies by ASR provider.
- When enabled and supported, context-aware processing may use a bounded selection and neighboring editor text for rewriting or adapting the transcription.
- If AI cleanup is disabled, unavailable or fails, the app should retain useful original text rather than silently lose the transcript. A selected-text edit must not overwrite the selection unless the edit was actually applied.

## History and personal data

- SayForge stores application settings and transcription history locally in its SQLite database; associated audio recordings are stored as separate files when history/audio archiving is enabled.
- History provides access to original and processed text, metadata, favorites and available audio. A user can disable history and remove entries.
- Audio and logs have configurable retention. The current default audio retention is unlimited unless the user changes it.
- Settings-only export/import is distinct from a full backup containing history and audio. WebDAV backup is optional and requires configuration.
- API credentials and sensitive transcription data must not be included in public issues, logs attached to bug reports or repository commits.
- Local data is isolated under `%LOCALAPPDATA%\com.oriapps.sayforge`. Other installations' data is not silently imported, modified or removed.

## Product rules and constraints

- **Dictation first:** a shortcut-to-text workflow is the main purpose of the application.
- **Two engines only:** Cloud API and Local; no separate Server Mode.
- **English UI:** the application interface currently supports English only. ASR output can be in other languages supported by the selected model/provider.
- **No silent loss:** failed or uncertain insertion should provide a recovery path whenever recognized text exists.
- **No silent data migration:** preserve independent app identity and require explicit import to transfer data.
- **Explicit cloud use:** local recognition and optional remote AI refinement are separate choices.
- **Manual releases:** do not enable automatic updates until the independent release/signing pipeline is verified.
- Preserve AGPL-3.0 and applicable third-party redistribution obligations when publishing builds.

## Open questions

- Minimum supported Windows version and validated local-model hardware/driver requirements.
- Final release packaging, signing and update distribution policy.
- Whether further languages should be added to the UI; recognition-language support is a separate concern.
