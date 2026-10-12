# Contributing to SayForge

Issues, bug reports, documentation improvements and pull requests are welcome.
SayForge is independently maintained at
[Akilaydin/OriApps.SayForge](https://github.com/Akilaydin/OriApps.SayForge).

## Pull requests

All contributions, including those from maintainers and coding agents, must go through a pull request. Make changes on a separate branch; do not push directly to the default branch. Keep each PR focused.

Write a clear, self-contained PR title. Keep the description concise (typically 50–100 words) and use the repository's Problem and Solution template. Explain why the change matters and how it addresses the problem, rather than listing modified files. Do not invent claims about impact or metrics.

## Automated AI code review

After opening a PR, wait for feedback from the configured automated AI reviewer(s) (currently Codex). Read the feedback before merging. Treat each finding as a suggestion to assess critically against the code, requirements, and actual failure modes, not as an instruction to follow blindly.

Fix valid, relevant findings and push the changes to the same PR. If a finding is incorrect, irrelevant, or deliberately not adopted, explicitly explain the decision in the PR discussion. Do not silently ignore findings.

If updates trigger a new automated review, evaluate that feedback in the same way. Do not merge while substantive findings remain unaddressed. If the automated review fails or does not arrive, report that limitation instead of treating silence as approval.

## Before opening a PR

- Search existing issues and explain the goal and expected behavior.
- Keep changes focused; include regression tests for fixes.
- Run `cd client && npm ci && npm run test -- --run && npm run i18n:check && npm run build`.
- Rust changes should pass `cargo test --manifest-path client/src-tauri/Cargo.toml`
  on a configured Windows development environment.
- Never commit API keys, private endpoints, user audio or personal settings.
- AI-assisted changes are acceptable, but the contributor must understand,
  test and be able to explain their code.

## Licensing

All source-code contributions are made under the project's existing
[GNU AGPL-3.0](LICENSE). Preserve upstream copyright statements and clearly
identify your own changes. Do not add new third-party dependencies without
checking their licenses and binary-distribution requirements.

The maintainers review contributions and manage issues in this repository.

## Releases

Merge development into `main`, then promote a reviewed version to `release`.
GitHub Actions tests, builds and publishes the public Windows release automatically.
Version, branch, signing and recovery instructions: [Releasing SayForge](docs/releasing.md).
