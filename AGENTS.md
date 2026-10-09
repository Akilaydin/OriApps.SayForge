# AGENTS.md

## Purpose

This file tells coding agents how to work with the SayForge repository.

Use the project documents as sources of truth. Do not duplicate their full content here or invent product and architecture decisions that have not been made.

## Project documents

- `README.md` — project overview, installation, prerequisites and basic usage.
- `PRODUCT.md` — user-facing behavior, current scope, product rules, limitations and non-goals.
- `ARCHITECTURE.md` — system boundaries, runtime flows, persistence, integrations and technical invariants.
- `CONTRIBUTING.md` — contribution and licensing requirements.
- `THIRD_PARTY_NOTICES.md` — third-party dependencies and redistribution obligations.

Before a nontrivial change, read the relevant documents and inspect the actual implementation. If the code and documentation disagree, report the discrepancy instead of silently treating either as correct.

## Working rules

- Check Git status before editing. Preserve existing user changes; do not revert, stage or commit unrelated work.
- Prefer small, focused changes that follow the existing architecture and naming conventions.
- Do not expand scope with speculative features, infrastructure or abstractions.
- Preserve public behavior, stored settings, data formats and existing installation identities unless an explicit change requires otherwise.
- Keep tests close to the behavior or invariant being changed. Test failure paths, cancellations and compatibility migrations when relevant.
- Treat absent decisions as open questions, not permission to choose new behavior.
- Update `PRODUCT.md` when user-visible behavior, supported modes, languages, scope or limitations change.
- Update `ARCHITECTURE.md` when component responsibilities, runtime flow, storage, integrations or technical invariants change.
- Update `README.md` when installation, prerequisites or basic usage change.

## Repository-specific conventions

- SayForge is a **Windows desktop application**. The application lives in `client/`: React/TypeScript and Tauri 2 with Rust. Do not introduce a separate Python backend, hosted service or Server Mode without an explicit product decision.
- Keep `WorkMode` limited to `cloud_api` and `local`. Legacy `server` preferences are normalized to `cloud_api`; preserve existing cloud settings and user-created profiles during migration.
- Keep microphone capture, recording state and provider selection in the existing frontend services. Use Tauri commands for native Windows integration, local inference, persistence and cloud HTTP/WebSocket requests.
- Treat recording run IDs, cancellation, timeouts and late provider responses as correctness boundaries. Stale results must not be inserted into the user's editor.
- Respect focus/editability probing and insertion fallback behavior. Never silently discard recognized text when automatic insertion cannot be confirmed.
- Preserve the app identifier `com.oriapps.sayforge`, the `sayforge.db` filename and the independent `%LOCALAPPDATA%` directory. Do not automatically import, overwrite or remove another application's data.
- The current UI is English-only. Speech recognition language support is separate from UI localization. Do not reintroduce retired locale files or provider/model families as incidental cleanup.
- The supported local-model catalog contains NVIDIA Parakeet (English) and Nemotron (multilingual). Changes to catalog entries, download URLs or pinned checksums require explicit review and verification.
- Local ASR does not imply offline AI refinement: optional text cleanup can call a configured cloud AI provider. Keep this distinction visible in product behavior.
- Treat real user audio, transcripts, editor selections, API keys and backup credentials as sensitive. Do not expose their contents in logs, diagnostics, test fixtures or commits; use synthetic test data. Preserve bounded, untrusted handling of captured editor context.
- Keep global WebView2 environment arguments consistent for all windows. Do not configure per-window `additionalBrowserArgs` while windows share the same WebView2 user-data directory.
- Automatic update installation is disabled until SayForge has a verified signed distribution/update channel. Do not activate dormant update code as an unrelated change.
- Preserve AGPL-3.0 attribution and review third-party licenses, particularly LAME/LGPL obligations, before adding dependencies or distributing binaries.

## Development commands

Run frontend commands from `client/`:

```powershell
npm ci
npm run test
npm run i18n:check
npm run lint
npm run build
```

Run Rust tests from the repository root on a configured Windows toolchain:

```powershell
cargo test --manifest-path client/src-tauri/Cargo.toml
```

`npm run build` and Rust/native builds may require the Windows C++ toolchain, CMake, Vulkan SDK and downloaded dependencies. Do not run expensive installer/release builds for documentation-only edits.

## Validation expectations

- Run focused Vitest tests for the touched frontend behavior; run the complete suite when feasible.
- For native changes, run relevant Rust tests on a configured Windows environment.
- Run `npm run i18n:check` for changes to UI strings and `npm run lint` for frontend code changes.
- Run `git diff --check` and review the final diff. Report any checks that could not be run.
- For shortcuts, audio capture, text insertion, model downloads and installer changes, supplement automated tests with the appropriate Windows manual smoke test.
