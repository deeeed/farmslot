# Retained native visual judgment acceptance (lead execution)

Validated on iOS through the visual-receipt and cold Runs/Inbox recipes. Retain each execution's receipts and screenshots; fixture or host-test success alone is not native acceptance.

The ordinary run detail previously read recorded evidence without the output-review decision and manifest hash. The new fixture exercises that production route, independently of the separate visual-review-source feedback surface covered by `visual-runs-live.recipe.json`.

Use the already prepared isolated gateway/Metro stack and single owned iOS simulator, one device at a time. This script checks the selected gateway is loopback, matches GATEWAY_PORT, and is running from this checkout. Do not use a shared farm gateway. No new recording is made; preserve screenshots, recipe trace, stdout and native-visual-receipts.json. Source media remains in the private evidence directory.

In the lead's existing isolated proof environment, retain its values for FARMSLOT_HOME, FARMSLOT_GATEWAY_PROFILE, FARMSLOT_RUN_PROOF_FIXTURE, GATEWAY_PORT, METRO_PORT, PLATFORM=ios and IOS_SIMULATOR. The baseline fixture must name an owned writable run; orchestration must be disabled. The authenticated native profile must use its own test-automation service credential, generation zero. The helper never accepts an actor parameter or changes the native login identity. It creates a clearly named person delegator with no roles in the isolated gateway, adds an exclusive temporary project review policy and retires that delegator during cleanup. A source-locked project registry is unsupported and fails before admission; use the existing isolated legacy project registry.

Set FARMSLOT_NATIVE_VISUAL_SOURCE to the absolute directory of a genuine retained Sources execution with its original eligible `source-notification` visual claim, complete measured recording and every inventoried artifact. The helper validates hashes, package validity, closure identity and the media signature, copies at most 8 MiB unchanged and preserves the acceptance ledger. Text-only test video or a fabricated observed result is invalid.

Before the device window, run the read-only `dry-preflight` phase from the repository root. It does not import device helpers, launch an app, boot a simulator, write a native profile or mutate fixtures. Missing inputs are reported together, and both recipes are validated against their action manifest before boot. Keep its JSON plan private because it contains local paths and fixture identities.

Required additional inputs are `FARMSLOT_PROJECTS_DIR` inside the isolated home, `FARMSLOT_D05_WORKER_TASK` naming the actual worker task copy unless `baseline.workerTaskFile` supplies it, `FARMSLOT_NATIVE_RUN_RECEIPT` and `FARMSLOT_D05_ARTIFACT_ROOT`. The artifact root contains both recipe output directories. The private baseline names `home`, `runId`, `runFile`, and optionally `taskFile`, `workerRepo` and `workerTaskFile`. The run must exist, be writable, have a slot and belong to the active view. Preflight reads the actual gateway task copies, worker task, original iOS profile, retained media and both recipes. It returns hashes, deterministic scratch paths, explicit saved run/decision IDs and selectors, and the resolved exact `recipeParams.detail_title`.

```sh
# Existing isolated environment and private inputs must already be selected.
umask 077
node --import tsx apps/companion/scripts/agentic/prove-offline-runs.mjs dry-preflight > "$D05_PLAN_PATH"
# Continue only after exit status zero. Never use a partial plan.
export FARMSLOT_D05_PLAN="$D05_PLAN_PATH"
export FARMSLOT_D05_DETAIL_TITLE="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).recipeParams.detail_title)' "$FARMSLOT_D05_PLAN")"
```

Root resolves preflight failures headlessly until clean. Every native helper phase rereads the inputs and compares them with that same plan before using its paths and IDs. Preexisting scratch directories and identical fixture files may be reused. Cleanup removes journaled files only while their inode and contents still match; it uses nonrecursive directory removal and retains foreign contents. Dynamic admission files from an interrupted attempt fail preflight and need headless lead disposition. Do not use that failure to retry the native attempt.

In the lead's serial device window, use ONE simulator boot. Run the visual recipe, then the cold/detail recipe with their artifact directories under the checked root. Export the title above and pass the same value as `--param "detail_title=$FARMSLOT_D05_DETAIL_TITLE"` to both. For example, from `apps/companion`:

```sh
bash scripts/agentic/run-recipe.sh run scripts/agentic/recipe/recipes/recorded-visual-runs-live.recipe.json --param "detail_title=$FARMSLOT_D05_DETAIL_TITLE" --record-video=off --artifacts-dir "$FARMSLOT_D05_ARTIFACT_ROOT/visual" --json
# Only after success and restored app/profile readiness:
bash scripts/agentic/run-recipe.sh run scripts/agentic/recipe/recipes/runs-live.recipe.json --param "detail_title=$FARMSLOT_D05_DETAIL_TITLE" --record-video=off --artifacts-dir "$FARMSLOT_D05_ARTIFACT_ROOT/cold" --json
```

The cold recipe intentionally restarts the app once while the gateway is offline. It warms the explicit owned run and pending decision through actual online navigation, checks SQLite and read-only collection snapshots, requires preserved IDs/observedAt and visible saved age, taps a disabled real action, then requires current recovery without replay. Its assertion failures remain failures; a private written sequence cannot substitute for execution.

The recipe owns the device session and supplies FARMSLOT_AGENT_DEVICE_STATE_DIR and FARMSLOT_RECIPE_ARTIFACTS_DIR as for existing native recipes. Use a fresh artifact directory. Do not run the command outside the lead's serial validation slot. No installation or service startup is included. This is one bounded iOS attempt; stop after any failure. Android requires new lead steering.

Acceptance sequence, all in that one pass:

1. Copy unchanged real closure into a uniquely owned task, create an output-review decision with the inventory digest, admit through actual `run.bundle.retain`, then independently read its bound recorded evidence and policy.
2. Open the production evidence tab and tap Read report. Enter delegated review prose using the native input. Require actual enabled Looks right and capture it.
3. Hold the actual default `task.progress {slotId, runId}` response in the existing byte-preserving proxy after an external tags writer invalidates the observation. Require both actual Issue and Looks right controls to be disabled, tap its real coordinates and capture the screen. Require zero additional `run.reviewVisualClaim` requests on the live socket and zero receipts in independent `run.get`. Release before the proxy deadline.
4. Tap current Looks right. Independently require exactly one receipt, expected service/delegator, exact closure, reason and reviewed files, receipt membership in the selected decision and a `proven` claim from `run.recipeRunsForRun` with decisionId and evidenceSnapshotHash.
5. Tap Issue, enter prose and tap Record issue. Independently require exactly one additional receipt and `failed` projected claim with the same identity checks. Both passes require the copied ledger digest to remain unchanged.
6. Require exactly two judgment commands in the proxy, write independent receipt/transport evidence, restore the original iOS gateway profile, release/close proxy, remove the unique run/task/project and retire the setup delegator.

No private handler is called, no application state is injected, and no judgment endpoint is called by the proof driver. Only native taps submit judgments. The independent reads prove side effects. Invocation-time and late-context races belong to the focused production-hook/model regressions; this recipe proves reachable interaction.

Integration prerequisite: `services/gateway/scripts/visual-reply-proxy.mjs` currently allows only terminal.send, run.get and native.session.read. The observation lane/lead must add task.progress to that allowlist; this lane does not own it. The new phase deliberately requests task.progress and fails closed until that repair lands. It holds the default {slotId, runId} observation with no actor/context selector. Both Issue and Looks right must disable. The baseline must provide a real owned slot progress target; the independent progress read must succeed before the device flow. Copied retained media is preserved under the recipe artifacts directory and the retained bundle is not removed.

Lead checks after integration: run the focused `run-evidence.test.ts`, `useRunAcceptance.test.ts` and `useRunOutputReport.test.ts` through the workspace test runner, Companion typecheck, then the recipe above with video off. Current device authorization is one bounded iOS attempt. Stop on failure. Planned repository source-fault checks are host validation owned by root. They do not authorize another native attempt. No unexpected recorder/setup retry or Android execution without lead steering. This lane has run none of those checks.

FOLLOW-UPS: This sequence proves one retained visual judgment boundary on the selected platform. It does not prove the complete Draft5 matrix, current Sources execution, offline media caching, worker delivery, publication authority or the separate source-review feedback surface. Remaining Draft5 findings and the two AC gap sequences live in private task artifacts.

For iOS, set FARMSLOT_NATIVE_VISUAL_IOS_PROFILE to a private JSON file containing the original single isolated gateway profile with its existing id, url, authMode and presetSecret. The simulator must contain only that isolated profile. Do not print or commit this file. The existing stopped-app setup helper changes only its route to the loopback proxy before interaction and restores the original profile in cleanup. It preserves credentials and never writes evidence, verdicts, receipts or query results. Real taps/input use the existing screen-control client. Android routing remains in code but is not authorized for the current attempt. Set PLATFORM=ios and IOS_SIMULATOR explicitly.
