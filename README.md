<div align="center">
  <img src="docs/images/readme/icon.png" alt="SayForge placeholder icon" width="96" height="96">

  # SayForge

  **Open-source voice typing for Windows.** Press a shortcut, speak, and insert text where your cursor is.

  [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
  [![Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](https://github.com/Akilaydin/OriApps.SayForge)

  [Releases](https://github.com/Akilaydin/OriApps.SayForge/releases) · [Issues](https://github.com/Akilaydin/OriApps.SayForge/issues) · [中文](README.zh-CN.md)
</div>

## About

SayForge is an independently maintained Windows dictation application by **OriApps**.
Record speech using a configurable hotkey, transcribe it with a local model or your
own cloud API, optionally polish the text, and paste it into another application.

**Project origin:** SayForge is **based on** [SayIt](https://github.com/crosswk/SayIt)
by **Liu Qianglong (crosswk)** and contributors, not merely inspired by it.
It preserves SayIt's Git history, copyright attribution and
[GNU AGPL-3.0 license](LICENSE). SayForge is not affiliated with or endorsed
by the original maintainer; changes and support belong to this project.

### Features

- Global press-to-talk and hands-free shortcuts, with insertion into the active Windows app.
- Audio and text history, hotwords, optional AI cleanup and app-specific prompts.
- Cloud providers including custom OpenAI-compatible chat/audio endpoints.
- **Standard OpenAI input_audio** with **WAV or optional MP3** (64 kbps mono), and
  separate **System Instruction** and **User Prompt** for transcription.
- Local ASR backends (native components built with Rust/CMake/Vulkan).

## Install

See [SayForge Releases](https://github.com/Akilaydin/OriApps.SayForge/releases)
for builds **when they become available**. The current app and icons are undergoing
an independent-brand transition; a reviewed, signed release has not yet been published.

Until a verified SayForge update channel exists, **updates are manual only**.
The application does **not** download or install original SayIt updates.

### First run

1. Select a voice engine. For cloud dictation, choose **OpenAI-compatible service**,
   provide your own endpoint, model and API key, and select the standard chat audio protocol.
2. Configure the recording shortcut.
3. Press the shortcut, speak, release, and verify that the transcript reaches your text field.

The default Server-mode address is **http://127.0.0.1:8000**; this is a
localhost placeholder, **not** a publicly hosted ASR service. You can instead
configure your own cloud provider or local recognition model.

### Switching from SayIt

SayForge uses a different Windows app identity and data directory:

| | Original SayIt | SayForge |
| --- | --- | --- |
| App ID | `com.sayit.app` | `com.oriapps.sayforge` |
| User data | `%LOCALAPPDATA%\com.sayit.app` | `%LOCALAPPDATA%\com.oriapps.sayforge` |
| SQLite | `sayit.db` | `sayforge.db` |

Original data is **not deleted, overwritten or silently imported**.
For an intentional transfer, export settings in SayIt and import them in SayForge
through the built-in configuration export/import feature. Review your imported
endpoint, model and keys before testing. The settings-only export does not
include recorded audio and history; these stay in your SayIt installation.

If you want to run both applications, assign nonconflicting global shortcuts.

## Development

Client stack: **Rust + Tauri 2 + React + TypeScript**. A separate Python backend
is included for self-hosted Server mode and retains legacy `SAYIT_*` environment
variables for compatibility.

Requirements: Node.js 18+, Rust toolchain, Visual Studio C++ Build Tools,
CMake and the Vulkan SDK for the local inference modules.

```powershell
git clone https://github.com/Akilaydin/OriApps.SayForge.git
cd OriApps.SayForge/client
npm ci
npm run test -- --run
npm run build
npm run tauri -- build --bundles nsis
```

Placeholder icons are generated deterministically from source:

```powershell
python scripts/generate-placeholder-icons.py
```

Run that command **from the repository root**. The generated icons will be
replaced with a final original brand design later.

The optional server has its own [setup documentation](server/README.md).

## Contributions

Issues and pull requests **are welcome** in
[this repository](https://github.com/Akilaydin/OriApps.SayForge).
Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. Contributions to SayForge
are not automatically submitted to the original SayIt repository.

## License and third-party notices

The application and its modifications are distributed under
**GNU Affero General Public License v3.0 (AGPL-3.0)**. Keep notices and provide
corresponding source when distributing binaries.

The MP3 encoder uses `mp3lame-encoder`, `mp3lame-sys` and LAME, which carry
**LGPL-3.0** obligations. On Windows LAME is currently **statically linked**.
Public binary distribution therefore requires an additional LGPL compliance
review (including notices and any required relinking materials); an AGPL notice
alone is not sufficient. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Original project: [crosswk/SayIt](https://github.com/crosswk/SayIt).
SayIt copyright © 2026 Liu Qianglong and its contributors.
Independent changes © 2026 OriApps and contributors.
