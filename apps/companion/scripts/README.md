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

Prepared dev leases remove inherited `CI`, watch source edits, and set
`EXPO_PUBLIC_FARMSLOT_PREPARED=1` to acknowledge What's new only on those leases.
Prepare disables the selected client's dev-menu onboarding and floating button.
Normal launch scripts keep their release-note behavior. The iOS build warms Metro with `COMPANION_PREPARE_CLIENT=0`, then prepares the installed client. First launch can precede Gateway pairing; live proofs wait for the authorized farm bridge separately.

`yarn recipe` uses the installed provider's idle lifecycle: a closed simulator
runner stops after 100ms, and a sessionless daemon exits after 10s. Open sessions
and in-flight requests prevent daemon exit. Prepare never kills foreign owners;
an older device owner must close its session before another workspace can use it.

The live `dev-links.recipe.json` requires an owned Android emulator, two unused
`GATEWAY_PORT`/`METRO_PORT` values, a fresh `COMPANION_DEV_LINKS_PROOF_DIR` and
`COMPANION_DEV_LINKS_CLEAR_APP=1`. It clears that emulator app and starts its own
Gateway, node and Metro on an existing tmux server. Teardown restores the source
marker and stops its owned services. Use the signal-safe live entrypoint:
`COMPANION_ADAPTER_RN_BIN=node bash scripts/agentic/run-recipe.sh scripts/agentic/dev-links-live.mjs <fresh-evidence-dir>`.

The live provider handover check uses two fresh provider workspaces on an idle
simulator. Set `IOS_SIMULATOR` to its UDID and
`COMPANION_DEVICE_HANDOVER_PROOF_DIR` to fresh scratch, then run
`COMPANION_ADAPTER_RN_BIN=node bash scripts/agentic/run-recipe.sh scripts/agentic/device-handover-proof.mjs`.
It proves active-session preservation, closed-owner exit and successor capture.

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
