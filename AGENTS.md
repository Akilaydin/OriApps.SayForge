# AGENTS.md

Instructions for coding agents working on SayForge.

## Project documents

- `README.md` — setup and basic usage.
- `PRODUCT.md` — capabilities, scope, UX rules and limitations.
- `ARCHITECTURE.md` — components, data flow and technical invariants.
- `CONTRIBUTING.md` and `THIRD_PARTY_NOTICES.md` — contribution and license requirements.

Read the relevant documents and actual code before changing behavior. Report conflicts or unknown decisions rather than guessing.

## Working rules

- Check Git status and preserve unrelated changes. Use focused branches and commits.
- Prefer minimal changes using existing patterns. Avoid speculative features or abstractions.
- Preserve existing settings, data formats, APIs and user-visible behavior unless explicitly changing them.
- Test relevant failure, cancellation and timeout paths, not just successful execution.
- Update `PRODUCT.md` for behavior or scope changes, `ARCHITECTURE.md` for technical decisions, and `README.md` for setup changes.

## Project constraints

- The Windows app lives in `client/` and uses React/TypeScript with Tauri 2/Rust.
- The transcription mode is `cloud_api`; retired local-mode settings migrate without deleting models.
- React services own recording and transcription orchestration; Rust handles native Windows integration, storage and cloud provider calls.
- Recording run IDs must isolate cancellations and late responses. Never insert text from a stale run.
- Preserve focused-target probing and a copyable fallback when insertion fails or cannot be confirmed.
- Preserve the identity `com.oriapps.sayforge`, database `sayforge.db` and existing user data.
- The UI is English-only; speech recognition languages depend on the selected provider or model.
- Optional AI refinement may send text and editor context to a remote provider independently of ASR.
- Protect audio, transcripts, editor text, API keys and backup credentials. Use synthetic test data; do not expose real content in logs or commits.
- Configure WebView2 browser arguments globally for windows sharing one environment.
- Updates are manual until a verified signed release channel exists.
- Respect AGPL-3.0 and third-party redistribution requirements, including LAME/LGPL.

## Validation

From `client/`:

```powershell
npm ci
npm run test
npm run lint
npm run i18n:check
npm run build
```

`npm run lint` is currently blocked: ESLint 10 requires `eslint.config.*`, but the repository only has `.eslintrc.cjs`. Do not report lint as passing until the configuration is fixed.

For Rust changes, from the repository root:

```powershell
cargo test --manifest-path client/src-tauri/Cargo.toml
```

Run the checks relevant to the change, plus `git diff --check`. Manually verify Windows-specific shortcut, audio, insertion, model and installer behavior when affected. Documentation-only edits do not require a build.
