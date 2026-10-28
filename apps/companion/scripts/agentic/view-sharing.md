# Current-view sharing proof

Use the accepted ADR-033 Amendment 1 and `docs/reference/view-links.md`. Phase 1 produces HTTPS web URLs. Android App Links and iOS Universal Links are deferred.

Build and install a development binary with the declared Expo Clipboard dependency before running JavaScript that imports it. Record the native input hashes, APK digest, signing certificate, package, runtime version and installed module list separately from the served JavaScript source manifest. An older binary is insufficient.

Prepare an exclusive case outside the checkout with `view-sharing-fixture.mjs prepare`, then `prepare-worker` once. Run them from the source root with its tsx loader and Gateway tsconfig. The preparer uses owning credential/run stores and a private raw-input Node receiver. Give it a fresh short `TMUX_TMPDIR`; clear inherited `TMUX`, `TMUX_PANE` and native-owner environment from every service. Never use a shared farm or launch a provider.

Use explicit private Gateway, passive proxy, Metro, Android and authenticated Agent Chrome inputs. The web URL must be reachable HTTPS and the deployment must pin this same Gateway. Build the read-only foreground clipboard probe using `clipboard-probe/build.mjs`; record its installed APK receipt. It receives a nonce, not the expected URL.

Validate recipes through the actual source `runAdapterRnCli` wrapper before execution. `validate` is action-free. `run --dry-run` still executes commands and recording and must not be used as an import check. Run native recipes with `--record-video=full-run` in exclusive artifact directories:

- `view-sharing`: actual run clipboard, mounted web identity, native Share and both Voice gestures with explicit Send/discard.
- `view-sharing-identities`: startup-owned retained run A/current run B and a genuine prior full recording. Inspect pinned slot/run terminal refusals, choose a real timeline span, then measure native playback through a parent viewport resize. Disabled controls are inspected without tapping.
- `view-sharing-selections`: a retained document opened through its actual modal, followed by the native History toggle and a browser with previously saved filters.
- `prove-view-sharing-receipts.mjs`: real same-route Decisions navigation and an explicitly unavailable native session/node. This does not prove a loaded native conversation or launch a provider.
- `view-sharing-guards`: unsupported view, invalid/unset profile URL, Settings and restoration. Visual criteria require review; do not rename their verdicts.
- `view-sharing-profile-state`: explicit observations of the profile editor and result.
- `view-sharing-offline` then `view-sharing-recovery`: the existing app retains its run, copies offline and reconnects without replay.
- `view-sharing-terminal-voice` and `view-sharing-unavailable-voice`: the current terminal keeps its own target, and a missing Co-Pilot retains context without launch or recording.

The external owner must prove service PID/birth ownership. Bind the outage marker to the actual proxy PID/start ID before stopping Gateway. Retain it until actual readiness and native recovery. Preserve original failures. Stop on failure, close only owned resources, revoke only the fixture credential and verify ports independently. An SDK automation lease closes after each recipe; this does not imply an app restart.

Keep original traces, full videos and screenshots. Audit the actual target at press, clipboard nonce, mounted identity and correlated RPCs. Never inject component, cache or SQLite values, silently reset consumed counters, or treat an engine pass as visual acceptance.

Keep proof limits with each attempt. A fixture without historical slot pins or retained video occurrences cannot prove their device behavior. The independent mapping/selection tests cover those guards; never label them native proof. In-app HUD can be covered by a native menu or the OS share sheet. Preserve these original images and use actual mounted-view/protocol observations alongside them.

For the retained-selection proof, run `view-sharing-identity-fixture.mjs` once after the fresh base preparer and before Gateway startup. `FARMSLOT_VIEW_SHARING_RECORDING_SOURCE` names a complete successful recording artifact directory; original bytes and recording digests are preserved. Before the device starts, the private Gateway must return the fresh slot owner, ordinary retained run and a valid recorded package. Run `view-sharing-identity-proof.mjs inspect-source` through the source tsx loader and retain its exclusive receipt in `FARMSLOT_VIEW_SHARING_IDENTITY_SOURCE`. This input recording is not acceptance evidence for the new case. Playback continuity uses actual native time labels before and after a viewport resize, with a tested guard against waiting for a reset player to catch up.

The floating button only proves attachment. Before destination navigation, the identity recipe opens Settings and requires the actual active connected profile, healthy response, exact Gateway endpoint and exact Command Center URL. It observes visible destination content instead of relying on ancestor View identifiers omitted from Android accessibility snapshots. A transient foreground disconnection or an unrelated Review screen cannot satisfy these checks.

The continuity check changes the reserved Android viewport width and restores its exact prior override. It requires the actual player width to change before reading the first visible position, with the same app PID and the existing no-rewind/catch-up guards. Terminal views can leave a portrait lock, so this check makes no rotation claim.
