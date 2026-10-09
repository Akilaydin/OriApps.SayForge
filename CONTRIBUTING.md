# Contributing to SayForge

Issues, bug reports, documentation improvements and pull requests are welcome.
SayForge is independently maintained at
[Akilaydin/OriApps.SayForge](https://github.com/Akilaydin/OriApps.SayForge).

## Before opening a PR

- Search existing issues and explain the goal and expected behavior.
- Keep changes focused; include regression tests for fixes.
- Run `cd client && npm ci && npm run test -- --run && npm run build`.
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
