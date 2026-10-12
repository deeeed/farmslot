# Companion Scripts

Companion scripts are grouped by responsibility so public-facing app code, local
device harnesses, and release automation are easy to distinguish.

| Directory      | Purpose                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `agentic/`     | Farmslot recipe harness, Metro launch, and local device entrypoints.                               |
| `build/`       | Build-environment setup hooks used by EAS or local builds.                                         |
| `doctor/`      | Diagnostics and repair checks for generated native projects.                                       |
| `release/`     | Production Android build, one Play upload, closed-track promotion and verification; dry run first. |
| `screenshots/` | Store screenshot capture and framing utilities.                                                    |

Package script names in `package.json` are the stable entrypoints. Prefer those
over calling helper files directly unless a workflow explicitly needs a helper
path.

`yarn release:dry-run` shows the production Android plan. After the reviewed
release cut, `yarn release:production --execute` builds non-interactively,
updates Android only, submits the returned build ID to internal, promotes its
versionCode to alpha and verifies both tracks advanced. iOS requires an explicit
`--platform ios`; its submission still requires `--submit`. Preview/development
variants remain explicit. Public Play production releases stay manual.

The production submit profile owns the Play applicationId and service account
path. The existing credential helper links that account at execute time. A
private temporary directory holds build metadata and track baselines and is
removed on exit. With `--skip-build`, the script selects one finished production
store build and refuses an already submitted or older version before upload.
