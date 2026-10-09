# Product

`PRODUCT.md` defines SayForge's current user-facing behavior and scope. Implementation details belong in `ARCHITECTURE.md`.

## Overview

SayForge is an open-source Windows dictation app by OriApps. Press a global shortcut, speak, and insert recognized text into the active application. Users configure their own OpenAI-compatible speech endpoint.

## Current capabilities

- Configurable push-to-talk and hands-free shortcuts, microphone selection and a recording overlay.
- Cloud speech recognition; cloud audio is uploaded after recording stops; live captions are not supported.
- Optional AI cleanup with one editable prompt and an OpenAI-compatible endpoint.
- Hotwords, text replacements, formatting and context-aware editing of selected text.
- Searchable local text history with copying and TXT export.
- Local settings export/import and legacy ZIP restore, tray controls and diagnostics.

## Dictation workflow

1. Select a microphone, speech engine and recording shortcut.
2. Record speech; the overlay shows the current state.
3. Stop recording. Speech is transcribed and optionally refined.
4. Insert the result into the captured editable target. If insertion fails or cannot be confirmed, show a copyable fallback card.

Cancellation must not insert late results. Empty/silent recordings can produce no text. Not every Windows application permits automatic insertion.

## Speech engines

**Cloud API:** sends recorded audio directly to the configured provider. Only OpenAI-compatible HTTP endpoints are supported: multipart audio/transcriptions or chat audio. Protocol/model support determines hotwords. OpenAI-compatible chat audio supports WAV or optional MP3 input. Users provide endpoint, model and optional API credentials and pay any provider charges directly. Existing OpenAI/Groq file profiles migrate to this interface; incompatible vendor/realtime profiles remain stored and require compatible endpoint setup.

Legacy local-mode settings migrate to Cloud API. Downloaded model files and retired settings remain on disk.

## AI and personal data

- AI refinement is optional and configured separately from ASR. It may send recognized text and bounded editor context to a cloud provider.
- If refinement is disabled or fails, preserve useful source text. Do not overwrite a selection unless the requested edit was actually applied.
- Settings and transcription history are stored locally. New recordings are not archived; older audio files and history remain untouched.
- Text history can be disabled. Settings exports exclude history and audio; older ZIP backups can still be restored after confirmation. Backups are local and initiated by the user.
- The app uses `%LOCALAPPDATA%\com.oriapps.sayforge`. Protect user transcripts, credentials and editor context.

## Scope and limitations

- Windows desktop only; English UI. Recognition-language support depends on the chosen engine.
- No hosted SayForge account, subscription or managed cloud storage.
- Meeting recording, system-audio capture and speaker diarization are outside the current scope.
- Application installation and updates are manual through GitHub Releases. About shows the current version and release link; no update checks, downloads or automatic installer run in the app.

## Open questions

- Supported minimum Windows version.
- Release signing and update distribution.
- Future UI language support.
