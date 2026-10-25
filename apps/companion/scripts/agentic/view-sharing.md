# Current-view sharing proof

Use the accepted ADR-033 Amendment 1 and `docs/reference/view-links.md`. Phase 1 produces HTTPS web URLs. Android App Links and iOS Universal Links are deferred.

Build and install a development binary with the declared Expo Clipboard dependency before running JavaScript that imports it. Record the native input hashes, APK digest, signing certificate, package, runtime version and installed module list separately from the served JavaScript source manifest. An older binary is insufficient.

Prepare an exclusive case outside the checkout with `view-sharing-fixture.mjs prepare`, then `prepare-worker` once. Run them from the source root with its tsx loader and Gateway tsconfig. The preparer uses owning credential/run stores and a private raw-input Node receiver. Give it a fresh short `TMUX_TMPDIR`; clear inherited `TMUX`, `TMUX_PANE` and native-owner environment from every service. Never use a shared farm or launch a provider.

Use explicit private Gateway, passive proxy, Metro, Android and authenticated Agent Chrome inputs. The web URL must be reachable HTTPS and the deployment must pin this same Gateway. Build the read-only foreground clipboard probe using `clipboard-probe/build.mjs`; record its installed APK receipt. It receives a nonce, not the expected URL.

Validate recipes through the actual source `runAdapterRnCli` wrapper before execution. `validate` is action-free. `run --dry-run` still executes commands and recording and must not be used as an import check. Run native recipes with `--record-video=full-run` in exclusive artifact directories:

- `view-sharing`: actual run clipboard, mounted web identity, native Share and both Voice gestures with explicit Send/discard.
- `view-sharing-guards`: unsupported view, invalid/unset profile URL, Settings and restoration. Visual criteria require review; do not rename their verdicts.
- `view-sharing-profile-state`: explicit observations of the profile editor and result.
- `view-sharing-offline` then `view-sharing-recovery`: the existing app retains its run, copies offline and reconnects without replay.
- `view-sharing-terminal-voice` and `view-sharing-unavailable-voice`: the current terminal keeps its own target, and a missing Co-Pilot retains context without launch or recording.

The external owner must prove service PID/birth ownership. Bind the outage marker to the actual proxy PID/start ID before stopping Gateway. Retain it until actual readiness and native recovery. Preserve original failures. Stop on failure, close only owned resources, revoke only the fixture credential and verify ports independently. An SDK automation lease closes after each recipe; this does not imply an app restart.

Keep original traces, full videos and screenshots. Audit the actual target at press, clipboard nonce, mounted identity and correlated RPCs. Never inject component, cache or SQLite values, silently reset consumed counters, or treat an engine pass as visual acceptance.
