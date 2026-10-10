# Product

`PRODUCT.md` defines SayForge's current user-facing behavior and scope. Implementation details belong in `ARCHITECTURE.md`.

## Overview

SayForge is an open-source Windows dictation app by OriApps. Press a global shortcut, speak, and insert recognized text into the active application. Users configure their own OpenAI-compatible speech endpoint.

## Current capabilities

Cloud ASR profile editors can test unsaved fields without changing the active saved
profile. The active-profile test uses saved settings and the bundled audio sample.

Cloud ASR settings are captured when recording starts. Changing the active profile,
API key, upload format or prompts during recording applies to the next recording.

- Configurable push-to-talk and hands-free shortcuts, microphone selection and a recording overlay.
- Microphone boost is optional and adjustable in Settings → Microphone from 0–18 dB in
  1 dB steps. New installs and existing installs without these settings default to
  enabled at +6 dB (approximately ×2); disabling boost gives 0 dB while retaining
  the slider position. Settings persist locally and apply to the next dictation.
  Only SayForge's captured audio is amplified; the Windows microphone input level
  stays unchanged and WebRTC automatic gain control is disabled. The microphone
  test uses the same capture settings and can adjust gain during the test.
  High gain levels may increase noise or clip loud speech. Input warnings are
  limited to before speech is detected, so normal pauses do not prompt the user.
- Cloud speech recognition; cloud audio is uploaded after recording stops; live captions are not supported.
- Optional AI cleanup with one editable prompt and an OpenAI-compatible endpoint.
- Hotwords, text replacements, formatting and context-aware editing of selected text.
  Default text replacements cover common technical terms; an explicitly saved
  empty list disables replacements, and existing custom lists remain unchanged.
- Dictionary shows hotword delivery for the active HTTP protocol. Multipart uses its
  prompt for punctuation; chat sends hotwords as context without guaranteeing a match.
- Searchable local text history with copying and TXT export.
- Local settings export/import and legacy ZIP restore, tray controls and diagnostics.
- Windows autostart is an explicit choice in Settings; new installs leave it off.
  Existing choices are preserved and enabled startup launches minimized in the tray.

## Dictation workflow

1. Select a microphone, speech engine and recording shortcut.
2. Record speech; the overlay shows the current state.
3. Stop recording. Speech is transcribed and optionally refined.
4. Insert the result into the captured editable target. If insertion fails or cannot be confirmed, show a copyable fallback card.

Cancellation must not insert late results. Empty/silent recordings can produce no text. Not every Windows application permits automatic insertion.
When clipboard protection is enabled, insertion backs up supported clipboard formats
and restores them if the clipboard has not changed.
If a format cannot be backed up safely or the clipboard is unavailable, SayForge
leaves the original contents untouched and shows the copyable fallback card.
For keyboard-only insertion and other unverified results, SayForge shows the
copyable fallback card even if Windows accepted the input events.

## Speech engines

**Cloud API:** sends recorded audio directly to the configured provider. Only OpenAI-compatible HTTP endpoints are supported: multipart audio/transcriptions or chat audio. Protocol/model support determines hotwords. New profiles default to MP3 (64 kbps mono) for multipart and standard chat; existing and migrated profiles keep WAV or their selected format. Legacy chat always uses WAV. Endpoints rejecting MP3 require manually selecting WAV; there is no automatic codec retry. Users provide endpoint, model and optional API credentials and pay any provider charges directly. Existing OpenAI/Groq file profiles migrate to this interface; incompatible vendor/realtime profiles remain stored and require compatible endpoint setup.

Legacy local-mode settings migrate to Cloud API. Downloaded model files and retired settings remain on disk.

## AI and personal data

- AI refinement is optional and configured separately from ASR. It may send recognized text and bounded editor context to a cloud provider.
- If refinement is disabled or fails, preserve useful source text. Do not overwrite a selection unless the requested edit was actually applied.
- Settings and transcription history are stored locally. New recordings are not archived; older audio files and history remain untouched.
- Text history can be disabled. Settings exports exclude history and audio; older ZIP backups can still be restored after confirmation. Backups are local and initiated by the user.
- Legacy restore replaces archived settings/collections and matching audio files, preserving unrelated audio. Limits: 64 MiB JSON, 512 MiB per audio file, 8 GiB each for the ZIP file and extracted audio total, and 100,000 ZIP entries. Invalid archives are rejected; ordinary restore failures roll back database and audio changes. Process termination or power loss during restore is not covered by that rollback.
- The app uses `%LOCALAPPDATA%\com.oriapps.sayforge`. Protect user transcripts, credentials and editor context.

## Scope and limitations

- Windows desktop only; English UI. Recognition-language support depends on the chosen engine.
- No hosted SayForge account, subscription or managed cloud storage.
- Meeting recording, system-audio capture and speaker diarization are outside the current scope.
- Application installation is via GitHub Releases. Newer signed releases support optional updates: check GitHub once at startup or manually from About; show the available version with **Update/Later**; never download or install without consent. A declined update can be offered on the next launch. A background check failure is silent; manual failures are reported. Startup from tray does not force-open the main window. Installation waits for any recording, processing, late text insertion or outstanding result card to finish. Older manual-only builds must be upgraded once with the GitHub installer.
- One Windows NSIS `.exe` installer offers current-user or all-users installation.
  The built-in selection requires administrator access in either mode. Installing
  for all users shares application binaries; settings, API keys and history remain
  separate for each Windows user.

## Open questions

- Supported minimum Windows version.
- Windows Authenticode code signing and minimum supported installer/upgrade scope.
- Future UI language support.
