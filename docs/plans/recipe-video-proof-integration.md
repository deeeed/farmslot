# Recipe Video Proof Integration Plan

Status: active supporting plan  
Supports: `docs/reference/recipe-protocol-v1.md`, `docs/reference/recipe-runtime-capability-contract.md`, `docs/PRD-runner-execution-canonical.md`  
Lifecycle: promote into reference docs after implementation; delete this plan once shipped.

## Problem

Recipe Protocol v1 already models recording intent through `record` values such as `proof_window`, but video capture is not yet a first-class runtime capability. Current project prompts work around this with ad hoc wrappers. This makes videos too long, inconsistent, and hard for agents to discover.

Observed gaps:

- recording often wraps the whole task/run, including setup, waiting, retries, and idle time;
- some prompts use repo-embedded wrappers or platform-specific commands instead of the node-advertised capture toolchain;
- agents cannot reliably discover video support from the recipe runner manifest;
- agents cannot reliably discover whether screenshots and live window streaming are available on the node;
- videos are not consistently registered in `artifact-manifest.json`.

## Goal

Make video proof a recipe-layer capability:

```bash
recipe-runner run recipe.json --record-video --artifacts-dir artifacts/run
```

The runner records an optional whole-recipe MP4 by default, writes it under the run artifact directory, and registers it in the artifact manifest. Proof-window clipping remains an advanced mode for cases where a shorter focused clip is worth the extra lifecycle complexity.

## Non-goals

- No product-specific recording commands in prompts.
- No mandatory video for every recipe run or every acceptance criterion.
- No replacement for screenshots; screenshots remain cheaper and preferred for static visual proof.
- No cross-platform guarantee in phase 1. macOS-only via externally installed `capture-helper` is acceptable when discoverability reports the limitation.

## Layering

| Layer                     | Owns                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| External `capture-helper` | Generic macOS window discovery, snapshot, stream, and MP4 recording. Installed on each machine node (PATH or `CAPTURE_HELPER_PATH`). |
| Farmslot node             | Tool install/doctor checks, live `screen.subscribe` streaming into Farmslot, node-local screenshot/thumbnail capture.                |
| Farmslot recipe harness   | Recording lifecycle, artifact registration, permission diagnostics, `record` policy interpretation.                                  |
| Project runner            | Target resolution: which browser/window/simulator to record.                                                                         |
| Project prompt/skill      | High-level guidance only: use runner recording when motion proof helps.                                                              |

Project runners must not reimplement capture. They provide a `RecordingTargetProvider` to the harness.
Farmslot must not rely on the repo-embedded development binary as the integration contract; production nodes should install the external `capture-helper` package and expose its status.

## Protocol contract

Existing `record` values remain valid:

| Value          | Video behavior                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `none`         | Never record.                                                                                                            |
| `trace_only`   | Do not record media; trace only.                                                                                         |
| `proof_window` | Marks reviewer-visible proof. Phase 1 may satisfy this with the single run-level video when `--record-video` is enabled. |
| `failure_only` | Record failure evidence, or preserve recent buffered proof if supported.                                                 |

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
--record-video=full-run|off
--record-max-fps 15
--record-max-size 720
--record-app-name <name>
--record-window-name <substring>
--record-window-id <id>
--record-pid <pid>
```

Defaults:

- `--record-video` means `full-run`;
- `proof-window` is reserved for future focused clips and intentionally rejected by the phase 1 harness so users are not misled;
- no video is captured unless the flag is present or project policy enables it.

## Harness recording lifecycle

Phase 1 records one whole-recipe video when requested:

1. If `--record-video` is omitted, execute normally with no media change.
2. If enabled:
   - resolve one target through the project runner or explicit CLI target flags;
   - run external `capture-helper doctor --json` once and fail with actionable install/permission diagnostics if unavailable;
   - start recording before recipe execution;
   - execute the recipe normally;
   - stop recording after the recipe settles;
   - verify the MP4 exists and is non-empty;
   - register the video in `artifact-manifest.json`.

Future proof-window mode may use the same provider to clip only selected nodes/flows, but it is not exposed by the phase 1 harness.

Failure behavior:

- In phase 1, if `--record-video` is explicitly requested and video recording fails, the recipe fails with recorder diagnostics. A later protocol update may add a `pass-with-gaps` verdict for optional evidence gaps.
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
    recipe-run.mp4
```

Manifest entry shape:

```json
{
  "path": "videos/recipe-run.mp4",
  "type": "video",
  "mimeType": "video/mp4",
  "category": "proof",
  "nodeId": "recipe-run",
  "label": "Recipe run video",
  "record": "full_run",
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

## Node and runner capabilities

Machine nodes should surface the capture stack status as node capabilities because screenshots, recordings, and live streaming all depend on node-local tools and permissions:

```json
[
  {
    "capability": "capture.screenshot",
    "status": "supported",
    "provider": "capture-helper",
    "platforms": ["macos"],
    "artifactTypes": ["image/png"]
  },
  {
    "capability": "capture.stream",
    "status": "supported",
    "provider": "capture-helper",
    "platforms": ["macos"],
    "modes": ["framed-h264"]
  },
  {
    "capability": "record.video",
    "status": "supported",
    "provider": "capture-helper",
    "platforms": ["macos"],
    "modes": ["full_run"],
    "artifactTypes": ["video/mp4"]
  }
]
```

Unsupported status should include the failed doctor code and an installation/permission fix, for example:

```json
{
  "capability": "capture.stream",
  "status": "unsupported",
  "provider": "capture-helper",
  "reason": "capture-helper is not on PATH; install the external capture-helper tool on this node"
}
```

Live window streaming into Farmslot remains a node/gateway concern: the node handles `screen.subscribe`, runs `capture-helper stream --framed` or the compatible framed mode, and relays frames to the gateway/UI. Recipe video proof should reuse the same installed toolchain but should not bypass the node streaming contract.

## Runner manifest

Runners that support video must expose a runtime capability:

```json
{
  "capability": "record.video",
  "status": "supported",
  "provider": "capture-helper",
  "platforms": ["macos"],
  "modes": ["full_run"],
  "artifactTypes": ["video/mp4"]
}
```

If unsupported:

```json
{
  "capability": "record.video",
  "status": "unsupported",
  "reason": "capture-helper is not installed on this node"
}
```

Agents should discover this through the runner manifest, not through prompt-specific shell snippets.
For screenshot actions, runners should also declare `ui.screenshot` and/or `capture.screenshot` support so agents know screenshot proof is available before writing recipes.

## Target provider contract

Project runners implement:

```ts
interface RecordingTargetProvider {
  resolveRecordingTarget(context: RecordingTargetContext): Promise<RecordingTarget>;
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
If motion proof helps, run the recipe with `--record-video`. The runner records one recipe-run video and writes it under `artifacts/run/videos/`.
```

Remove direct prompt guidance for platform-specific video commands except as a last-resort debugging note.

## Acceptance criteria

1. `recipe-runner run --record-video` creates one whole-recipe MP4 when motion/visual proof is useful.
2. Videos are opt-in; screenshot-only recipe runs remain unchanged when `--record-video` is omitted.
3. Videos are registered in `artifact-manifest.json` with a stable run-level link.
4. Runner manifest exposes `record.video` support or an explicit unsupported reason.
5. macOS permission failures surface `capture-helper doctor` diagnostics.
6. The docs and prompts do not imply every acceptance criterion needs a video.
7. Project prompts no longer instruct agents to use platform-specific video commands as the primary path.

## Implementation phases

### Phase 1 — Harness capability

- Add recording provider wrapper around external `capture-helper record`.
- Add `--record-video` CLI plumbing where the harness CLI exists.
- Add run-level artifact registration and MP4 verification.
- Add capability manifest support.
- Add node doctor/capability reporting for `capture.screenshot`, `capture.stream`, and `record.video`.

### Phase 2 — Project runner target providers

- Add browser/window target provider for web/extension-like runtimes.
- Add simulator window target provider for mobile simulator runtimes.
- Keep target resolution project-owned; keep capture generic.

### Phase 3 — Prompt and skill alignment

- Replace direct recording snippets in project templates.
- Update recipe skills to mention runner recording only.
- Keep direct `capture-helper` commands documented only as operator/debug fallback and installation troubleshooting.

### Phase 4 — Evidence packaging

- Include videos in PR evidence packages.
- Keep videos local unless the human explicitly approves upload.
- Prefer short videos; screenshots remain default for static claims.
