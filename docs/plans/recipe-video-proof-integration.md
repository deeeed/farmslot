# Recipe Video Proof Integration Plan

Status: active supporting plan  
Supports: `docs/reference/recipe-protocol-v1.md`, `docs/reference/recipe-runtime-capability-contract.md`, `docs/PRD-runner-execution-canonical.md`  
Lifecycle: promote into reference docs after implementation; delete this plan once shipped.

## Problem

Recipe Protocol v1 already models recording intent through `record` values such as `proof_window`, but video capture is not yet a first-class runtime capability. Current project prompts work around this with ad hoc wrappers. This makes videos too long, inconsistent, and hard for agents to discover.

Observed gaps:

- recording often wraps the whole task/run, including setup, waiting, retries, and idle time;
- some prompts use Farmslot `record-window.sh` / `capture-helper`, while others use platform-specific commands;
- agents cannot reliably discover video support from the recipe runner manifest;
- videos are not consistently registered in `artifact-manifest.json`.

## Goal

Make video proof a recipe-layer capability:

```bash
recipe-runner run recipe.json --record-video --artifacts-dir artifacts/run
```

The runner records only proof windows by default, writes MP4 artifacts under the run artifact directory, and registers them in the artifact manifest.

## Non-goals

- No product-specific recording commands in prompts.
- No mandatory video for every recipe run.
- No replacement for screenshots; screenshots remain cheaper and preferred for static visual proof.
- No cross-platform guarantee in phase 1. macOS-only via `capture-helper` is acceptable when discoverability reports the limitation.

## Layering

| Layer                   | Owns                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `capture-helper`        | Generic macOS window discovery, snapshot, and MP4 recording.                                        |
| Farmslot recipe harness | Recording lifecycle, artifact registration, permission diagnostics, `record` policy interpretation. |
| Project runner          | Target resolution: which browser/window/simulator to record.                                        |
| Project prompt/skill    | High-level guidance only: use runner recording when motion proof helps.                             |

Project runners must not reimplement capture. They provide a `RecordingTargetProvider` to the harness.

## Protocol contract

Existing `record` values remain valid:

| Value          | Video behavior                                                           |
| -------------- | ------------------------------------------------------------------------ |
| `none`         | Never record.                                                            |
| `trace_only`   | Do not record media; trace only.                                         |
| `proof_window` | Record this node/flow when `--record-video` is enabled.                  |
| `failure_only` | Record failure evidence, or preserve recent buffered proof if supported. |

Default phase policy remains:

| Phase         | Default        |
| ------------- | -------------- |
| `setup`       | `trace_only`   |
| `start_state` | `trace_only`   |
| `proof`       | `proof_window` |
| `assert`      | `trace_only`   |
| `teardown`    | `trace_only`   |

A setup node may use `record: "proof_window"` only when setup itself is the reviewer-visible claim.

## Runner CLI

Minimum CLI additions:

```bash
recipe-runner run recipe.json \
  --artifacts-dir artifacts/run \
  --record-video
```

Optional advanced flags:

```bash
--record-video=proof-window|full-run|off
--record-max-fps 15
--record-max-size 720
--record-app-name <name>
--record-window-name <substring>
--record-window-id <id>
```

Defaults:

- `--record-video` means `proof-window`;
- `full-run` is explicit and should be rare;
- no video is captured unless the flag is present or project policy enables it.

## Harness recording lifecycle

For each node/flow:

1. Determine effective record policy from node, flow, phase default, and CLI.
2. If policy is not active, execute normally.
3. If active:
   - resolve target through the project runner;
   - run `capture-helper doctor` once per run and fail with actionable permission diagnostics if unavailable;
   - start `capture-helper record` immediately before the proof node/flow;
   - execute the node/flow;
   - stop recording immediately after the node/flow settles;
   - verify the MP4 exists and is non-empty;
   - register the video in `artifact-manifest.json`.

Failure behavior:

- If the recipe node passes but video recording fails, the recipe verdict is `pass-with-gaps` unless the proof target explicitly requires video.
- If the recipe node fails and `failure_only` is configured, capture or preserve failure video when possible.
- Permission errors must include the `capture-helper doctor` code and suggested fix.

## Artifact layout

```text
artifacts/run/
  summary.json
  trace.json
  artifact-manifest.json
  screenshots/
  videos/
    001-ac1-open-menu.mp4
    002-ac2-submit-form.mp4
```

Manifest entry shape:

```json
{
  "path": "videos/001-ac1-open-menu.mp4",
  "type": "video",
  "mimeType": "video/mp4",
  "category": "proof",
  "nodeId": "ac1-open-menu",
  "proofTarget": "AC1",
  "label": "AC1 proof window",
  "record": "proof_window",
  "recorder": {
    "name": "capture-helper",
    "version": "...",
    "platform": "macos",
    "target": {
      "selector": "window-id",
      "value": "..."
    }
  }
}
```

## Capability manifest

Runners that support video must expose a runtime capability:

```json
{
  "capability": "record.video",
  "status": "supported",
  "provider": "capture-helper",
  "platforms": ["macos"],
  "modes": ["proof_window", "full_run"],
  "artifactTypes": ["video/mp4"]
}
```

If unsupported:

```json
{
  "capability": "record.video",
  "status": "unsupported",
  "reason": "capture-helper is not available on this host"
}
```

Agents should discover this through the runner manifest, not through prompt-specific shell snippets.

## Target provider contract

Project runners implement:

```ts
interface RecordingTargetProvider {
  resolveRecordingTarget(context: RecipeRunContext): Promise<RecordingTarget>;
}

type RecordingTarget =
  | { kind: 'window-id'; windowId: string }
  | { kind: 'pid'; pid: number }
  | { kind: 'app-window'; appName: string; windowName: string };
```

Examples:

- Browser/extension runner: resolve the active browser window or browser PID from launch artifacts.
- Mobile simulator runner: resolve the simulator app/window from runtime context or device name.

The harness owns capture invocation once the target is resolved.

## Prompt cleanup

Replace platform-specific recording snippets with runner-level language:

```md
If motion proof helps, run the recipe with `--record-video`. The runner records proof windows and writes videos under `artifacts/run/videos/`.
```

Remove direct prompt guidance for platform-specific video commands except as a last-resort debugging note.

## Acceptance criteria

1. `recipe-runner run --record-video` creates MP4 proof-window videos for nodes/flows with effective `record: "proof_window"`.
2. Setup/start-state is not recorded by default.
3. Videos are registered in `artifact-manifest.json` with node/proof-target links.
4. Runner manifest exposes `record.video` support or an explicit unsupported reason.
5. macOS permission failures surface `capture-helper doctor` diagnostics.
6. Existing screenshot-only recipe runs remain unchanged when `--record-video` is omitted.
7. Project prompts no longer instruct agents to use platform-specific video commands as the primary path.

## Implementation phases

### Phase 1 — Harness capability

- Add recording provider wrapper around `capture-helper record`.
- Add `--record-video` CLI plumbing where the harness CLI exists.
- Add artifact registration and MP4 verification.
- Add capability manifest support.

### Phase 2 — Project runner target providers

- Add browser/window target provider for web/extension-like runtimes.
- Add simulator window target provider for mobile simulator runtimes.
- Keep target resolution project-owned; keep capture generic.

### Phase 3 — Prompt and skill alignment

- Replace direct recording snippets in project templates.
- Update recipe skills to mention runner recording only.
- Keep direct `capture-helper` commands documented as operator/debug fallback.

### Phase 4 — Evidence packaging

- Include videos in PR evidence packages.
- Keep videos local unless the human explicitly approves upload.
- Prefer short videos; screenshots remain default for static claims.
