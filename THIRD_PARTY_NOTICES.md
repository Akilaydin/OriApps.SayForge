# Third-party licenses and attribution

## Upstream application source

- Source and copyright attribution: see the
  [License and third-party notices](README.md#license-and-third-party-notices)
  section in the README.
- Original application by Liu Qianglong (crosswk) and contributors.
- License: GNU Affero General Public License v3.0 (`LICENSE`).
- SayForge is a modified distribution of the original source. Git history
  and copyright attribution are deliberately preserved.

## MP3 encoding libraries

- `mp3lame-encoder` v0.2.5 — LGPL-3.0:
  https://github.com/DoumanAsh/mp3lame-encoder
- `mp3lame-sys` v0.1.11 — LGPL-3.0:
  https://github.com/DoumanAsh/mp3lame-sys
- LAME 3.100 is bundled by `mp3lame-sys`.
- On Windows, `mp3lame-sys` **statically links** the LAME C library.

**Before publishing executables:** review all third-party binary licenses
and satisfy the LGPL requirements concerning notices, source and the
ability to modify/relink the linked LGPL library. Providing an AGPL source
repository alone may not satisfy the LGPL static-linking obligations.

## Other dependencies and assets

- Native transcribe.cpp bindings (`transcribe-cpp`) identify as MIT-licensed.
- Other JavaScript, Rust and Python dependencies retain their own licenses.
  Review the resolved dependency lists before distribution.
- The current icon artwork is maintained with its design source files under
  `assets/branding`.
- Historic source and acknowledgements remain available in the Git history.

This notice is not a substitute for a complete distributable license inventory.
