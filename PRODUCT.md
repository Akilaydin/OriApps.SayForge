# Product

`PRODUCT.md` defines SayForge's current user-facing behavior and scope. Implementation details belong in `ARCHITECTURE.md`.

## Overview

SayForge is an open-source Windows dictation app by OriApps. Press a global shortcut, speak, and insert recognized text into the active application. Users choose a local model or their own cloud speech provider.

## Current capabilities

- Configurable push-to-talk and hands-free shortcuts, microphone selection and a recording overlay.
- Cloud and local speech recognition, including supported realtime transcript feedback.
- Optional AI cleanup, custom prompts, presets and per-application prompt rules.
- Hotwords, text replacements, formatting and context-aware editing of selected text.
- Searchable local history, favorites, audio playback and text export.
- Settings/full backup and restore, optional WebDAV backup, tray controls and diagnostics.

## Dictation workflow

1. Select a microphone, speech engine and recording shortcut.
2. Record speech; the overlay shows the current state.
3. Stop recording. Speech is transcribed and optionally refined.
4. Insert the result into the captured editable target. If insertion fails or cannot be confirmed, show a copyable fallback card.

Cancellation must not insert late results. Empty/silent recordings can produce no text. Not every Windows application permits automatic insertion.

## Speech engines

**Cloud API:** sends recorded audio directly to the configured provider. Supported integrations include OpenAI, Groq, Gemini, OpenRouter and custom OpenAI-compatible endpoints. Protocol/model support determines streaming and hotwords. OpenAI-compatible chat audio supports WAV or optional MP3 input. Users supply their own endpoint, credentials and payment arrangements.

**Local:** runs a downloaded GGUF model on the user's device. The catalog includes NVIDIA Parakeet Unified EN (English) and Nemotron 3.5 ASR (multilingual, including Russian). Performance and compatibility depend on available hardware and drivers.

## AI and personal data

- AI refinement is optional and configured separately from ASR. It may send recognized text and bounded editor context to a cloud provider, even when recognition is local.
- If refinement is disabled or fails, preserve useful source text. Do not overwrite a selection unless the requested edit was actually applied.
- Settings and transcription history are stored locally; audio files are stored separately when enabled.
- History and retention are configurable. Settings-only exports do not include history or audio. WebDAV backups require explicit configuration.
- The app uses `%LOCALAPPDATA%\com.oriapps.sayforge`. Protect user transcripts, credentials and editor context.

## Scope and limitations

- Windows desktop only; English UI. Recognition-language support depends on the chosen engine.
- No hosted SayForge account, subscription or managed cloud storage.
- Meeting recording, system-audio capture and speaker diarization are outside the current scope.
- Application installation and updates are manual until a verified signed release channel is available.

## Open questions

- Supported minimum Windows version and local-inference hardware requirements.
- Release signing and update distribution.
- Future UI language support.
