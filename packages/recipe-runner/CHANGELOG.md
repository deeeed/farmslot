# Changelog

All notable changes to `@farmslot/recipe-runner` (published as `@farmslot/recipe-harness` up to 0.22.1) are tracked here.

## Unreleased

- Harness 0.94.5 verifies Extension RPC readiness through the registered background API and checks optional Perps probes independently.

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.46.1 - 2026-10-21

- Align with `@farmslot/protocol` 0.61.0.

## 0.46.0 - 2026-10-20

- The CDP `app.hud` renderer shows the current intent as a 16px main line with no badge, never clipped, a muted `N/M`, and the step that just finished as one muted `✓`/`✗` line, remembered per transport across page connections. The card defaults to 500px wide; detail and error lines clamp at `display.maxDetailLines` (2).

## 0.45.0 - 2026-10-19

- Align with `@farmslot/protocol` 0.59.0.

## 0.44.0 - 2026-10-19

- Align with `@farmslot/protocol` 0.58.0.

## 0.43.0 - 2026-10-19

- `summary.json` records `taskActions` when the host passes the actions a task action manifest provided (`RecipeRunRequest.taskActions`).

## 0.42.0 - 2026-10-19

- A `review` claim (ADR-062 Amendment 18) derives `awaiting-review`, never `missing`, and `proven` only when the gateway review authority says the code review certifies the package; its parent re-aggregates with it, and planning refuses a node that `proves` one.
- Align with `@farmslot/protocol` 0.57.0.

## 0.41.0 - 2026-10-19

- Engine stills are lossy WebP at quality 85 (ADR-062 Amendment 17): `stills/<key>-<attempt>.webp` and `stills/recorded-<n>.webp`, registered as `image/webp`, and no PNG original is kept. `recordVideo.stillFormat: 'png'` or `recipe run --record-still-format png` keeps lossless PNG. The encoder is libwebp compiled to WebAssembly (`@jsquash/webp`) on a worker thread. `captureRecordingSnapshot` and recipe-named screenshots are unchanged.
- Align with `@farmslot/protocol` 0.56.0, which carries the `stillFormat` default.

## 0.40.0 - 2026-10-19

- `ActiveVideoRecording.ready()`'s contract now includes the lead-in: it resolves once the segment's zero is bounded and one `EVIDENCE_PADDING_MS` has been recorded past it (ADR-062 Amendment 16). Documentation only; the runner is unchanged.
- `resolveRecipeRunSelection` resolves what a run command names: a ref, platform alias or `<library>.<ref>` id from the active libraries, else a recipe file with its adjacent task libraries. It returns the libraries with their digests, the match and the `selection` for the run summary. The CLI's `run` uses it, unchanged, and so does `farmslot recipe run`.
- The README's CLI examples use `farmslot recipe run`, since `farmslot-recipe` is removed.

## 0.39.5 - 2026-10-18

- The capture-helper recorder waits for the host's capture slot when another slot on the same host is recording. Since capture-helper 0.3.3, one of its commands at a time may use ScreenCaptureKit per host user, and the second slot's run-start doctor or `record.video` start failed with `capture_busy`, failing the proof. Doctor and start now retry for up to 10 minutes (`captureSlotWaitMs`, polled every `captureSlotPollMs`), then fail with the reason. The doctor reports `capture_busy`, not a permissions fix. The run's cancel ends the wait and is recorded as `RECIPE_ABORTED`; teardown waits on its own signal. `VideoRecorderStartRequest.signal` and `doctor(VideoRecorderDoctorOptions)` are new and optional. Recordings through the Android mirror keep main's behaviour (`captureSlotWaitMs: 0`): a busy host falls back to screenrecord at once, and a mirror start never waits.

## 0.39.4 - 2026-10-18

- A recorder's active recording can expose `ready()`, resolving once its current segment's frame zero is bounded; the runner waits for it before every proof node, so a node no longer starts while capture restarts. Segmented and limit-bound recordings pass it through (ADR-062 Amendment 15).

## 0.39.3 - 2026-10-18

- Full-run recording starts before the first proof node, a UI action or an assertion, instead of the first UI action, and that node runs 1 s after capture starts, so assertions that prove a claim before the first tap are recorded instead of left outside the recording. Setup that proves nothing still runs before capture, and a run that binds at a proof node takes 1 s longer (ADR-062 Amendment 14).

## 0.39.2 - 2026-10-18

- Align with `@farmslot/protocol` 0.55.0.

## 0.39.1 - 2026-10-17

- Network capture summaries redact credential-like path segments: 20 or more base64url characters mixing letters and digits, such as an API or write key in the path (`/v1/projects/<key>/settings`, `/v3/<project id>`). Before, only 0x addresses, 64+ hex, JWTs and segments over 64 characters were redacted, so a client write key reached `network/run-summary.json`. Long resource ids such as UUIDs and hashes in a path are now redacted as well.

## 0.39.0 - 2026-10-17

- Run a gateway-authorised repair through `RecipeRunRequest.repairScope`: retain the original packages, write the engine claim-source selection and project each claim from its selected execution; retained captures stay bound to the revision they were recorded at, across repeated repairs.
- MetaMask provider teardown can stop checkout console viewers while retaining the borrowed browser and development server.
- Coordinate MetaMask provider 0.92.12 checkout-scoped iOS companion shutdown; runtime contracts are unchanged.

## 0.38.4 - 2026-10-16

- Align the worker dependency set with parent acceptance inheritance and Protocol 0.53.0.

## 0.38.3 - 2026-10-16

- Align the worker dependency set with Protocol 0.52.0 and default pipeline visual review.

## 0.38.2 - 2026-10-16

- Align the worker dependency set with Protocol 0.51.0.

## 0.38.1 - 2026-10-16

- Use bounded filesystem-safe still filenames for nested recipe nodes, preserving their distinct artifact identities.

## 0.38.0 - 2026-10-16

- Accept reasonless person confirmations only from qualified visual-review receipts, preserving raw evidence validation.

## 0.37.2 - 2026-10-16

- Align the worker dependency set with Protocol 0.49.0 person-device sessions.

## 0.37.1 - 2026-10-15

- Use the operator-wait runtime and protocol dependency set.

## 0.37.0 - 2026-10-15

- Replace `ActionAdapter` with `ActionHandler` and `defineActionAdapter` with `defineActionHandler`.

## 0.36.2 - 2026-10-15

- Align the published dependency set with protocol 0.47.0 initial resource proof modes.

## 0.36.1 - 2026-10-15

- Bound file-backed evidence reads and hashing across concurrent packages, and close each descriptor before releasing its read slot.

## 0.36.0 - 2026-10-15

- Retain AC/role/source capture bindings and immutable baseline closures, using one comparison projection for publication and both review clients.

## 0.35.0 - 2026-10-15

- Allow platform screenshots to capture their native window before falling back to CDP, preserving rooted artifact writes, recorded snapshots and capture-provider metadata.

## 0.34.3 - 2026-10-15

- Align the installed worker dependency closure with protocol 0.44.0 and provenance-bound branch maintenance.

## 0.34.2 - 2026-10-14

- Align public dependencies with protocol 0.43.1 and its optional HUD conformance guard.

## 0.34.1 - 2026-10-14

- Bind UI recording after session setup so a fresh browser launch records the replacement process before the first UI proof.

## 0.34.0 - 2026-10-14

- Compare dependency staleness against recorded input content. Identical fixture copies and timestamp-only changes do not request reinstall; absent baselines remain explicit, and changed content needs a successful install record.
- Derive visual review outcomes through the existing engine without rewriting retained evidence.

## 0.33.0 - 2026-10-14

- Generate an attempt-local publication evidence manifest automatically from recorded artifacts and claim verdicts.
- Validate resolved enabled waits before setup and observe them through the shared CDP target, disabled semantics and cancellable polling.
- Derive file-content state claims from executed `assert_file` expectations, retaining the checked path and match outcome while keeping existence-only checks ineligible.
- Keep the engine as the only summary and artifact-manifest writer; trusted hosts register closeout metadata and sidecars before package validation.

## 0.32.0 - 2026-10-13

- Reject task acceptance ledgers used as recipe claim packages with an explicit schema error.
- Harness proof consumers apply the shared intent contract during recipe-cli planning as well as doctor conformance.
- Refuse reruns into retained recipe artifact packages before recording or execution; use a fresh artifact directory to keep prior evidence intact.
- Honor HUD top/bottom placement through automatic progress and capture the painted final outcome.
- Bind recorded evidence to execution-indexed files and consumed metadata, excluding unrelated task artifacts.
- Expose the existing occurrence recording-coverage helper and trusted-host reader transport to the shared review model; equal-byte originals retain their distinct clocks (ADR-062).

## 0.31.0 - 2026-10-12

- Add bounded `watch_logs` observation with cancellation. Breaking correction: run-scoped logs now require paths resolved before producers execute; output-derived paths must declare `scope=file`, and stale content no longer passes parameterized observations.

- Send browser virtual key codes for common control keys, function keys and ASCII letters/digits so `ui.key_press` reaches keyboard handlers; input clearing uses the same key dispatch.

- Honor nested `all`/`any`/`none` output assertions and reject invalid static assertion JSON paths during preflight, including parameterized and called recipes.

## 0.30.0 - 2026-10-12

- Expose one retained evidence-package reader for CLI and gateway validation, with contained file reads, actual byte digests and read diagnostics.

- Collect opt-in rendered HUD observations around screenshot capture for live conformance.
- Expose the existing contained artifact digest helper for conformance evidence checks.
- **BREAKING:** Derive claim verdicts, measured moments and source-frame stills automatically; UI runs require a recording target before execution unless explicitly disabled with a reason. Bound recording and preserve original segments and partial capture, including completed media when lease cleanup fails (ADR-062).
- Keep recipe HUD intent on two bounded lines through the shared display policy, with authoring warnings above 80 characters and errors above 120.

## 0.29.0 - 2026-10-11

- Accept a caller cancellation signal, stop later recipe nodes after cancellation, and record `RECIPE_ABORTED` while still running authored teardown. Graph execution scopes shared leaf helpers to each phase's signal, including nested calls and fresh teardown signals across source and installed module copies. Signal-aware commands and timeouts clean their owned process groups; callers without signal transport retain their existing foreground-group behavior and bounded timeouts even when descendants hold output pipes.

## 0.28.5 - 2026-10-11

- Exact-plan approval excludes the lifecycle `RECIPE_RUN_OWNER_PID`, so a reviewed plan works in a new CLI process. All substantive environment inputs remain bound; providers validate the owner separately.

- Align the protocol dependency with 0.37.0 so consumers resolve one copy.

## 0.28.4 - 2026-10-10

- Keep measured partial footage when the owned Android mirror exits, and report `CAPTURE_INTERRUPTED`. The completion HUD waits for recorder finalization, including caller-owned recordings through `RecipeRunRequest.finalizeRecording`; interrupted or failed finalization draws FAIL. Losing the HUD endpoint with the capture keeps the incomplete-evidence classification; independent HUD and product failures remain failures. CDP calls reject immediately after connection closure. Session screenshots stop using cached frames as soon as the helper reports `stream_stopped`; fresh capture waits for encoder finalization. Interruption messages omit unmeasured frame counts and media times instead of reporting zero as a measurement.

- Publish with protocol 0.36.0 so consumers share one dependency copy.

## 0.28.3 - 2026-10-10

- Fix: `{{outputs.node.items[0].field}}` resolved to its own text, so an `assert_output` compared the value against the template; `{{outputs.node.items.0.field}}` failed as not defined. Both now index the array. A `{{params.` or `{{outputs.` that does not parse as a template fails resolution with `RECIPE_PARAMS_INVALID`. Resolution errors quote the template as written, name the node (`resolveRecipeValue` option `nodeId`), and report an index past the end of an array as out of range. Needs the protocol release with `parseRecipeTemplate`.
- A run whose only failure is an interrupted recording is reported as incomplete evidence, not as a product failure: `finalizeRecipeSuite` marks its verdict `evidence_incomplete` with the partial video. Exports `CAPTURE_EVIDENCE_INCOMPLETE` (from protocol), `isCaptureInterruptedEntry`, `onlyCaptureInterrupted`, `loneCaptureInterruption` and `readRunTraceEntries` (a trace.json's entries in either shape), the one rule every consumer uses.
- Publish with protocol 0.35.2.

## 0.28.2 - 2026-10-09

- A capture-helper recording whose stream stops mid-run (capture-helper 0.3.1: `stream_interrupted`, exit 3) keeps its partial video: the video entry carries `interruption`, and the run fails with a `CAPTURE_INTERRUPTED` environment failure (`RecipeRunResult.captureInterruption`). A screenshot after, or during, the stream stop is taken with a standalone `capture-helper snapshot` of the same target, marked `metadata.fallbackFrom: 'record_session_snapshot'`, instead of failing with "Recording is no longer active."
- Publish with protocol 0.35.1.

## 0.28.1 - 2026-10-09

- The automatic HUD node (`run:hud`) is the runner's own: it no longer needs approval for an untrusted recipe source when its `app.hud` implementation is trusted, and it stays in the plan digest, so an approval covers one HUD policy. An approval made with another HUD or video setting is refused as `RECIPE_APPROVAL_MISMATCH`, which now says so. A recipe still cannot declare the node: `run:hud` is not a valid node id, and a recipe node's `automatic` field keeps the recipe's origin.
- Fix: the CDP `app.hud` draws its text in a closed shadow root under the same `#farmslot-recipe-hud` host, so `ui.wait_for` text checks and text-target presses no longer match the HUD's own text (a node's intent naming the text it waits for passed at once). Each update replaces the host, now `aria-hidden`. Like the web HUD, it caps the title, intent, detail and error lines at 180 characters, whitespace flattened, with `…` on the cut, and never splits an emoji.

## 0.28.0 - 2026-10-09

- Add `detect` to a recipe-library.json `adapters` entry: `remote`, `files` and `packageDependencies`, each an array of strings (`RecipeLibraryAdapterDetect`). `readRecipeLibraryManifest` validates it (a `files` entry must be checkout-relative, without `..`) and keeps it in `RecipeLibraryAdapterDeclaration.detect`, so a host can recognise a plugin's checkout without importing the plugin.
- Publish with protocol 0.35.0.

## 0.27.1 - 2026-10-09

- Fix: Android `app.lifecycle` single-quotes the target's app id and launch URL for the device shell. adb joins the words after `shell` into one command line the device parses, so a launch URL with `&` (an Expo dev-client link with more than one query parameter) was cut short and backgrounded there, and a `;` ran the rest as a second device command. Each now reaches `am`/`monkey` as one argument.
- Publish with protocol 0.34.0.

## 0.27.0 - 2026-10-08

- Add a `lenient` option to `resolveRecipeValue(value, params, outputs, { lenient })`: only an exact reference to a parameter that exists resolves, anything else stays as written, and nothing throws. Static validation in `@farmslot/recipe-cli` resolves parameters this way.
- Publish with protocol 0.34.0.

## 0.26.0 - 2026-10-06

- Add `@farmslot/recipe-runner/runtime/cdp-trace`, the CDP performance trace engine moved from mm-harness: `createCdpTraceCollector(client, { kind, platform, marker, markerPrefix })` runs one `Tracing` capture at a time and aligns it to the host clock through a marker the host writes into the trace; `parseTraceCapture(capture, kind)` turns a capture into JavaScript-task and native-frame samples with summaries. A `TraceKind` names what a trace captures (categories, renderer scoping, scope label, native source, JavaScript-task flag, `draw` or `cadence` frame timing), so the host keeps its own platform names. The marker prefix defaults to `farmslot-clock-`. `summarizeFrames` (from `@farmslot/adapter-rn`) and `summarizeJavaScriptTasks` move here too, unchanged.
- Publish with protocol 0.34.0.

## 0.25.0 - 2026-10-06

- The library digest (`digestRecipeLibrary`) covers every file under each declared adapter module's directory, not only the module file, so a plugin's helper files move it. A module at the library root contributes itself and the library's `actions/`, not the whole root. Add `libraryAdapterFiles(root, declaration)` (the module's directory plus the library's `actions/`, the files a host lets the plugin import) and `digestLibraryAdapter(root, declaration)` for one plugin. The module's directory is listed strictly (`listLibraryFiles(root, directory, { strict: true })`): dot-files are digested, and a `node_modules`, a symlinked directory, or more than `MAX_LIBRARY_ADAPTER_FILES` (1,000) files fails with `RECIPE_SOURCE_INVALID`.
- Publish with protocol 0.34.0.

## 0.24.0 - 2026-10-05

- Add `@farmslot/recipe-runner/cdp-broker`: the CDP broker that shares one inspector connection between bridge commands and long-lived collectors, moved from mm-harness. Both React Native and browser-extension network capture use it.
- Publish with protocol 0.34.0.

## 0.23.0 - 2026-10-04

- **Breaking:** renamed from `@farmslot/recipe-harness`. Run provenance, the bundled recipe source and the packages a library's `requires` can name now report `@farmslot/recipe-runner`. `RECIPE_HARNESS_VERSION`, `runRecipeHarnessCli`, `createRecipeHarnessProgram` and `RecipeHarnessCliOptions` are now `RECIPE_RUNNER_VERSION`, `runRecipeRunnerCli`, `createRecipeRunnerProgram` and `RecipeRunnerCliOptions`. There is no `@farmslot/recipe-harness` alias package.
- Publish with protocol 0.34.0.

## 0.22.1 - 2026-10-03

- `@farmslot/recipe-harness/cli` no longer uses top-level await, so CommonJS consumers can `require()` it and every other package entry, `@farmslot/recipe-cli` included. Running `dist/cli/index.js` directly still starts the CLI and exits 1 with the error message on failure.

## 0.22.0 - 2026-10-02

- Keep run plan digests stable across repeated `yarn <script>` runs: only the values Yarn changes per invocation or derives from the package (its shim paths, `npm_package_*`, user agent, `INIT_CWD`/`PROJECT_CWD`, Corepack root) leave the approved environment; user-set `npm_config_*` and `COREPACK_*` settings stay bound. Log the `Recipe libraries:` line as soon as libraries load, so early failures keep it. `run` and `validate` exit 2 for a malformed `--library` or `RECIPE_LIBRARY_PATH` entry, and a library root that does not exist fails with `RECIPE_LIBRARY_PATH_INVALID` instead of a raw ENOENT.
- Recognize custom recipe adapter folders from the active adapter or a library's platform manifest. Preserve built-in adapters and qualified custom references across library precedence.
- **Breaking:** the `farmslot-recipe` bin moves to `@farmslot/recipe-cli`; install that package (or `npx -p @farmslot/recipe-cli farmslot-recipe`) instead of running it from `@farmslot/recipe-harness`. `recipe-library.json` keys are all optional and gain `adapters`, `actions` and `requires`; `requires` is enforced on every load and fails closed for packages the host cannot check. Library files load and digest through one walker that skips dot-entries, `node_modules` and symlinked directories and rejects files outside the library root. A `--library` entry replaces the `RECIPE_LIBRARY_PATH` entry with the same name, `run` accepts `<library>.<ref>` ids, and `run` records each library's content digest (line-ending independent) in its provenance. `run` records the selected recipe (`recipeSelection`) in `summary.json` and only warns about shadows it executes. A malformed library path entry fails with `RECIPE_LIBRARY_PATH_INVALID`. Export the library helpers discovery tools need.

## 0.21.1 - 2026-09-29

- Keep operation records, logs and newly created runtime directories readable under restrictive inherited umasks.

## 0.21.0 - 2026-09-29

- Retain invocation-scoped command stages, timings and logs for live operation observers.

## 0.20.0 - 2026-09-28

- Prefer capture-helper's native frame and snapshot timing, wait for its first recorded frame, and retain trace-linked action markers; preserve variable frame timing for browser recording fallback.
- Use active recording-session screenshots and an owned Android mirror for physical-device capture, with explicit fallback provenance and process cleanup.

## 0.19.0 - 2026-09-27

- The visual review board can reopen a downloaded or Companion-exported feedback JSON (`Open feedback JSON`), keeping surface and capture ids and refusing malformed feedback or feedback for another capture, and every page, the index included, shows whether the file opened. Drafts are stored per capture; `feedbackDraftFromDocument` exposes the same restore for tests and other renderers.
- Add canonical `ui.scroll_to`: one harness algorithm over a provider `withScrollSession` hook (implemented for CDP) that no-ops when the target is already in the HUD-safe viewport, moves once, waits for geometry to settle and verifies the final bounds; contract failures are `harness` with stable `SCROLL_*` codes and geometry in trace `error_code`/`error_details`. `ui.scroll` now separates absolute `offset_x`/`offset_y` from relative `delta_x`/`delta_y` (a lone `delta_x` no longer adds a 600px vertical step). Add `stopAfterNode` / `--stop-after-node` to run the graph through one node and then its declared teardown.

## 0.18.1 - 2026-09-21

- Retain typed, redacted invocation parameters with the recipe digest and execution summary; canonical artifact validation now reads those inputs for parameterized runs and rejects mismatches or redacted credentials.

## 0.18.0 - 2026-09-20

- Published against `@farmslot/protocol` 0.30.0 so one protocol copy serves every dependent (child checklist units and the acceptance ledger arrive through that pin).

## 0.17.0 - 2026-09-18

- Publish against `@farmslot/protocol` 0.29.0 so downstream installs resolve one protocol version.

## 0.16.3 - 2026-09-17

- Publish against `@farmslot/protocol` 0.28.0 so a consumer that also installs `@farmslot/agent-runtime` 0.10.0 resolves one protocol copy.

## 0.16.2 - 2026-09-13

- Publish against `@farmslot/protocol` 0.26.0 so a consumer that also installs `@farmslot/agent-runtime` 0.9.0 resolves one protocol copy.
- Clear selected text before typing a replacement during CDP recipe playback.

## 0.16.1 - 2026-09-09

- Include native form controls and checkbox/radio/switch roles in browser readiness hit tests, so an actionable modal does not block its own setup.

## 0.16.0 - 2026-09-07

- Wait for stable CDP click targets, refresh contexts invalidated by navigation before dispatch, and run app restart preparation only once.
- Reserve `recipes/shared/` for cross-adapter recipes while preserving their domain names, duplicate checks, and adapter-specific override precedence.
- Preserve completed action output and a single trace entry when HUD completion fails; retain the failed run verdict and execute teardown.

## 0.15.1 - 2026-08-28

- Classify unresolved relative or absolute bundle imports as source errors instead of missing package dependencies, while retaining missing-package precedence for mixed failures.

## 0.15.0 - 2026-08-14

- Align the packaged Recipe Protocol dependency with 0.21.0 so consumers use one execution-capability and evidence contract runtime.

## 0.14.0 - 2026-08-03

- feat(visual-review): start navigation maps at the top level with independently collapsible branches and expand/collapse-all controls.
- feat(visual-review): label multi-platform captures as variants of one surface and expose an explicit Compare mode.
- feat(visual-review): provide a lightweight project-agnostic review-board builder, recipe-artifact converter, and dynamic-port server with self-contained route/capture feedback plus color-coded, movable point and drag-area annotations.
- feat(visual-review): default multi-platform boards to the platform from the latest build, remember the operator's iOS/Android selection across pages, and keep an explicit All comparison mode.
- feat(recipe): standardize `ui.capture_surface` and implement full-page CDP evidence capture.

## 0.13.0 - 2026-08-02

- **BREAKING:** Add canonical `recipes/<adapter>/<domain>/*.recipe.json`
  discovery and reserve top-level adapter directory names. Stable ids and
  temporary legacy suffixes remain supported; resolution errors are actionable
  and deterministic across `run` and `validate`.

## 0.12.1 - 2026-08-02

- Resolve CDP navigation URLs outside the page realm so LavaMoat-scuttled Extension pages can use shared navigation actions.

## 0.12.0 - 2026-08-02

- **BREAKING:** Replace `ui.gesture` with streamed swipe, pan, drag, and long-press transports; use `hold_ms`; reject unsupported active-adapter parameters after template resolution; and retain coordinate phases through explicit transport-result envelopes.

## 0.11.1 - 2026-08-01

- fix: keep iOS Simulator lifecycle restarts idempotent when `simctl` reports that it found nothing to terminate.

## 0.11.0 - 2026-08-01

- **BREAKING:** Run summaries now include structured totals and all four failure-cause counts required by the matching `@farmslot/protocol`; publish the protocol first and update harness consumers as one coordinated release.
- feat: preserve structured failure ownership in run evidence and finalize frozen suite scopes from completed recipe results or explicit non-execution records.

## 0.10.6 - 2026-07-31

- fix: scroll hardened browser pages through the document root without accessing scuttled window globals.

## 0.10.5 - 2026-07-31

- fix: retry DOM-settlement and compositor probes when navigation invalidates their frame or execution context, report transient or superseded probe races as suspended results or warnings instead of throws or false success, and preserve the public isolated-world evaluator across navigation.

## 0.10.4 - 2026-07-31

- fix: evaluate CDP DOM-settlement probes in a navigation-resilient isolated world so LavaMoat scuttling cannot break post-interaction readiness checks.

## 0.10.3 - 2026-07-30

- fix: publish the protocol workspace dependency as its concrete npm version for external consumers.

## 0.10.2 - 2026-07-30

- fix: avoid scuttled browser globals when matching visible text and producing observation selectors in hardened Extension pages.
- fix: expose npm-semver dependency version checks for host runtime-readiness bootstraps.

## 0.10.1 - 2026-07-30

- fix: capture-helper doctor failures report `capture_helper_exec_failed` (spawn/PATH/env) instead of claiming the tool is missing when only execution failed.
- fix: retry the compositor probe in a CDP isolated world when a hardened page blocks injected `requestAnimationFrame` access.

## 0.10.0 - 2026-07-24

- **BREAKING:** Read action support from the keyed manifest allowlist and derive recipe-library identity from configuration or path, removing redundant per-library metadata.
- Record the canonical action-manifest schema in run summaries.
- Bind passive observers to trust plans and emit the package version in CLI and run metadata.

## 0.9.4 - 2026-07-24

- Bound CDP HTTP discovery and abort stalled responses within the caller deadline.

## 0.9.3 - 2026-07-24

- Bound CDP WebSocket connection setup with an optional timeout that terminates stalled client handshakes.

## 0.9.2 - 2026-07-24

- Detect reachable-but-suspended browser pages with a read-only compositor probe.
- Treat the active Yarn linker marker as dependency-install authority and ignore uncertified legacy baselines.

## 0.9.1 - 2026-07-23

- Preserve the current Mobile route when foregrounding an app instead of reopening its launch URL.
- Accept finite numeric values in `ui.set_input` by converting them to decimal text.

## 0.9.0 - 2026-07-22

- **BREAKING:** Unify direct and nested execution on parameterized recipes, one ordered recipe index, and one recursive executor; remove the separate reusable graph CLI/runtime.
- Emit `recipe-resolution.json` plus exact digest-keyed reachable recipes and expose recipe list/describe discovery.
- Preflight nested parameters, depth, trust, and dependency paths before side effects; resolution failures include stable recovery guidance.
- Validate composed artifact packages from their retained dependency graph without requiring the source library.
- Discover an adjacent `recipe-library/` for task-authored recipes.

## 0.8.0 - 2026-07-19

- Added provenance-aware preflight/execution planning that blocks restricted capabilities from unknown or untrusted sources before side effects; approvals bind to the exact resolved plan digest
- Included automatic HUD execution in the approved plan
- Bound approvals to the project root, artifact destination, and effective run environment
- Fixed source-swap and symlink boundary bypasses across custom implementations, project reads, flow catalogs, and artifact/video writes
- Fixed managed-run approval recovery instructions and caller-selected library trust defaults
- Added an explicit-environment mode so host wrappers can exclude internal control variables from recipe execution and approval identity

## 0.7.0 - 2026-07-19

- Added `flows describe <ref>` with resolved provenance, parameter schema/defaults, the complete flow definition, and an authored call node or clearly labeled template in human and stable JSON output.

## 0.6.0 - 2026-07-13

- fix: require Yarn's `node_modules/.yarn-state.yml` install surface when `nodeLinker: node-modules`, so a leftover `.yarn/install-state.gz` cannot report removed dependencies as current

## 0.5.0 - 2026-07-12

- feat: record passive UI observations for default and node-level observe policies in recipe traces, including replayable controls inside open shadow roots without exposing input values as labels.
- fix: dependency readiness trusts install markers newer than dependency inputs even when an older recorded baseline exists, preventing unnecessary reinstall prompts in managed slots.
- fix: use workspace-linked `@farmslot/protocol` during local development so package builds cannot resolve a stale published sibling package.

## 0.4.3 - 2026-07-09

- fix: dependency readiness no longer treats an old recorded baseline as stale when install markers are newer than `package.json`/`yarn.lock`, avoiding repeated unnecessary reinstall prompts in managed slots

## 0.4.2 - 2026-07-09

- feat: a run that composes flows now emits `resolved-recipe.json` — the authored recipe with every reachable flow (inline, `uses`, or library, transitively) inlined under `flows`. This artifact is self-contained and validates as a complete recipe without the library
- feat: export `composeRecipe` / `buildResolvedRecipe` — the shared composition step used by the runner (executed path) and the CLI static resolve-check to derive the same `resolved-recipe.json`

## 0.4.1 - 2026-07-08

- `watch_logs` now defaults to run-scoped matching using file offsets captured at recipe start across the main workflow and called flows, so markers written before the run cannot satisfy log assertions. Use `scope: "file"` to explicitly scan the whole file

## 0.4.0 - 2026-07-07

- Add a standard outer `app.lifecycle` adapter for Android and iOS simulator launch/foreground/terminate/restart lifecycle control, with Android background support for performance recipes. Exported as `@farmslot/recipe-harness/adapters/app-lifecycle`.

## 0.3.3 - 2026-07-03

- `resolved-flows.json` is emitted whenever a run had any library resolution activity (used, overridden, or shadowed flows) — previously a run that overrode every library flow with recipe-local declarations produced no artifact even though `summary.json` recorded the overrides
- `flows promote` fails loudly, naming every offending catalog file, when the target library already declares the ref in more than one catalog (pre-existing corruption); `--force` no longer overwrites just one of the duplicates and leaves the library unloadable
- Multi-source recipe library resolution: `call` refs can resolve from ordered, named library sources (`--library name=path`, `RECIPE_LIBRARY_PATH`, or the personal library at `<farmslot home>/recipe-library`). First source wins; recipe-local flows always win. Nothing resolves silently for any consumer: cross-source shadowing and recipe-local overrides are recorded in `summary.json` `flowResolution` (`shadowed`, `overrides`) and in the `resolved-flows.json` artifact alongside the used definitions, in addition to logging
- `farmslot-recipe flows list` — list library flows with source, description, required params, and last-verified date across configured sources; exits non-zero when no source is configured
- `farmslot-recipe validate --library` — validate accepts library-resolved `call` refs with the same source resolution as run
- `farmslot-recipe flows promote` — promote an inline flow from a per-change recipe into a recipe library (default: the personal library, created on first promote). Enforces the catalog contract (description required, postcondition required for `ensure_*`), stamps `provenance.promotedFrom`/`promotedAt`, and stamps `lastVerified` only from a passing run's artifacts (`--run <dir>`)

## 0.3.2 - 2026-06-30

- Document `orchestrateRuntimeUp` `build` decision as terminal — hosts must call again after native build finishes.
- Use the installed `capture-helper` package for capture runs.

## 0.3.1 - 2026-06-26

- Add `runtime/orchestrate-up` — generic install → relaunch decision loop (`orchestrateRuntimeUp`) for product runners to wrap with shell/platform actions.

## 0.3.0 - 2026-06-26

- Add shared runtime-readiness helpers under `@farmslot/recipe-harness/runtime/*`:
  - `deps-readiness` — install fingerprint, baseline recording, product-marker partial checks, decision state persistence
  - `log-analysis` — Metro/RN bundle log boundaries, unresolved-module scoping, persistent bundle-error detection
  - `metro-probe` — packager `/status` reachability probe
  - `decision-types` — portable `RuntimeDecisionReport` / `RuntimeDecisionAction` shapes
- Product runners (e.g. MetaMask) should import these modules instead of copying readiness logic locally.

## 0.2.2 - 2026-06-10

- Publish with npm-resolvable `@farmslot/protocol` dependency metadata instead of workspace-only protocol references.

## 0.2.1 - 2026-06-10

- Drive CDP text inputs with trusted keyboard insertion instead of direct DOM value assignment so React-controlled inputs receive real input/change handling.
- Drive CDP clicks with real mouse events and expose `ui.key_press` through the standard UI adapter.

## 0.2.0 - 2026-06-02

- Define the v0 public harness package surface with explicit core, adapter, node, CLI, and runtime entry points.
- Publish recipe runner runtime helpers under explicit `runtime/*` subpaths for browser extension, CDP, and React Native bridge clients.
- Keep CLI and writer implementation details behind explicit subpath exports instead of wildcard package exports.

## 0.1.0 - 2026-05-31

- Initial public active-development release.
