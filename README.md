<div align="center">
  <img src="docs/images/readme/icon.png" alt="SayForge icon" width="96" height="96">

  # SayForge

  **Open-source voice typing for Windows.** Press a shortcut, speak, and insert text where your cursor is.

  [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
  [![Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](https://github.com/Akilaydin/OriApps.SayForge)

  [Releases](https://github.com/Akilaydin/OriApps.SayForge/releases) · [Issues](https://github.com/Akilaydin/OriApps.SayForge/issues)
</div>

## About

SayForge is an independently maintained Windows dictation application by **OriApps**.
Record speech using a configurable hotkey, transcribe it with your
own cloud API, optionally polish the text, and paste it into another application.

### Features

- Global press-to-talk and hands-free shortcuts, with insertion into the active Windows app.
- Searchable text history and TXT export, hotwords, optional AI cleanup and an editable prompt.
- OpenAI-compatible HTTP transcription and chat/audio endpoints with configurable URL, model and API key.
- **Standard OpenAI input_audio** with **MP3** (64 kbps mono) or WAV, and
  separate **System Instruction** and **User Prompt** for transcription.

## Install

Check [SayForge Releases](https://github.com/Akilaydin/OriApps.SayForge/releases)
for the Windows NSIS `.exe` installer. It offers installation for the current user
or all users; the built-in Tauri `both` mode requests administrator access in
either case. Settings, API keys and history remain separate for each Windows user.

Until a verified SayForge update channel exists, **updates are manual only**.
The application does not automatically download or install updates.

Releases are built and published automatically when a new version reaches the
`release` branch. See [Releasing SayForge](docs/releasing.md). Initial CI installers
are unsigned; Windows SmartScreen may warn about an unrecognized publisher.

### First run

Windows autostart is off for new installs. Enable **Start with Windows** in Settings
to launch in the tray. Updating preserves the existing Windows startup choice.

1. Select a voice engine. For cloud dictation, choose **OpenAI-compatible service**,
   provide your own endpoint, model and API key, and select the standard chat audio protocol.
2. Configure the recording shortcut.
3. Press the shortcut, speak, release, and verify that the transcript reaches your text field.

SayForge uses Cloud API: direct calls to a user-configured OpenAI-compatible
ASR endpoint. Retired local-mode settings migrate to Cloud API; downloaded models remain on disk.

### Application data and settings

SayForge uses an independent Windows app identity and data directory:

| Setting | SayForge |
| --- | --- |
| App ID | `com.oriapps.sayforge` |
| User data | `%LOCALAPPDATA%\com.oriapps.sayforge` |
| SQLite | `sayforge.db` |

SayForge does not import other application data automatically. To transfer
configuration, use the built-in export/import feature. Review imported
endpoints, models and keys before testing. A settings-only export does not
include recorded audio or history.

Choose global shortcuts that do not conflict with other applications.

## Development

Client stack: **Rust + Tauri 2 + React + TypeScript**. No separate SayForge
backend is required.

Requirements: Node.js 22.13+ (validated with 22.22), Rust toolchain and
Visual Studio C++ Build Tools, including the Windows SDK. The retained LAME encoder
compiles with the C/C++ toolchain; CMake and Vulkan SDK are not required.
The release packages contain the app and bundled synthetic Cloud API test audio;
no local ASR DLLs or model downloads are packaged. Tray WebView and overlay prewarm remain enabled.

```powershell
git clone https://github.com/Akilaydin/OriApps.SayForge.git
cd OriApps.SayForge/client
npm ci
npm run test -- --run
npm run build
npm run tauri -- build --bundles nsis
```

Source artwork is maintained in `assets/branding/`. Platform-specific PNG,
ICO assets are checked into `client/src-tauri/icons/`,
`client/src/assets/` and `docs/images/readme/`.


## Contributions

Issues and pull requests **are welcome** in
[this repository](https://github.com/Akilaydin/OriApps.SayForge).
Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License and third-party notices

The application and its modifications are distributed under
**GNU Affero General Public License v3.0 (AGPL-3.0)**. Keep notices and provide
corresponding source when distributing binaries.

The MP3 encoder uses `mp3lame-encoder`, `mp3lame-sys` and LAME, which carry
**LGPL-3.0** obligations. On Windows LAME is currently **statically linked**.
Public binary distribution therefore requires an additional LGPL compliance
review (including notices and any required relinking materials); an AGPL notice
alone is not sufficient. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

**Project attribution:** SayForge is a modified distribution **based on**
[SayIt by Liu Qianglong (crosswk)](https://github.com/crosswk/SayIt) and
contributors, not merely inspired by the original work. This independent
distribution is not affiliated with or endorsed by the original maintainer.
Its existing Git history, copyright attribution and AGPL-3.0 requirements
remain applicable to the modified source and any distributed binaries.

SayIt copyright © 2026 Liu Qianglong and its contributors.
Independent changes © 2026 OriApps and contributors.
