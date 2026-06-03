# Companion Scripts

Companion scripts are grouped by responsibility so public-facing app code, local
device harnesses, and release automation are easy to distinguish.

| Directory | Purpose |
| --- | --- |
| `agentic/` | Farmslot recipe harness, Metro launch, and local device entrypoints. |
| `build/` | Build-environment setup hooks used by EAS or local builds. |
| `doctor/` | Diagnostics and repair checks for generated native projects. |
| `release/` | Dry-run-first EAS build, update, and submit orchestration. |
| `screenshots/` | Store screenshot capture and framing utilities. |

Package script names in `package.json` are the stable entrypoints. Prefer those
over calling helper files directly unless a workflow explicitly needs a helper
path.
