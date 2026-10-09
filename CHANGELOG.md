# Changelog

Significant changes to SayForge will be recorded here. The complete earlier
source history remains available in Git.

## Unreleased

## 0.2.5

- Add optional, signed in-app GitHub Release updates, a manual check in About,
  download progress and safe waiting until dictation is finished.
- Add signed NSIS assets, `latest.json` and updater-manifest verification to the
  existing automatic Windows release pipeline.
- Established an independent Windows application identity and branding.
- Added direct cloud ASR via custom OpenAI-compatible endpoints, including WAV
  and MP3 audio and configurable transcription instructions.
- Retained on-device dictation with NVIDIA Parakeet and Nemotron models.
- Removed the self-hosted backend and Server Mode.
- Simplified the interface to English and removed provider-specific integrations
  that are no longer supported.
- Preserved AGPL-3.0 attribution and third-party license information in the
  README's licensing section.

## 0.2.4

- Publish one NSIS `.exe` installer with a choice of current-user or all-users
  installation. The built-in Tauri selection requires administrator access in
  either mode; settings and history remain per user.
- Stop building and publishing MSI; retain checksums, licenses and version/tag guards.

## 0.2.3

- Added automatic public Windows NSIS/MSI releases from the `release` branch,
  with tests, version/tag guards, checksums, licenses and corresponding source links.
