# Persistent node-link measurement plan

Supporting measurement plan for [ADR-008 Amendment 3](../adr/008-remote-communication.md#amendment-3-persistent-typed-node-link-2026-11-07). Execute after the release owner reports the complete 0.79 cohort live, including F366, F412, matching nodes and GUI/Aqua hosts. Publication or staging alone is insufficient. No baseline has run. Keep this plan through implementation qualification; promote the verified procedure to operations afterward.

## Setup

Use one reserved idle pilot node first, a disposable workspace, and publication-disabled startup fixtures. Include the gateway-host node as a separate control when it takes a different path. Check current workers, reviews, preparation and resource leases before reserving either. Do not restart services for measurement.

Save the actual source/cohort and gateway boot, node socket identity/capabilities, host generation, CC/Companion build, runner/model/effort, fixture size and CPU/memory/network load. Use one existing cheap installed runner/model; no new provider installation. Keep authentication values out of evidence. Collect serially with the same parameters, preparation/cache state and account context before and after.

From the selected source checkout, select an existing diagnostics-capable CLI profile, then record:

```sh
node apps/command-center/scripts/cdp.mjs gateway gateway.status '{}'
node apps/command-center/scripts/cdp.mjs gateway node.health.all '{}'
node apps/command-center/scripts/cdp.mjs gateway run.list '{}'
node apps/command-center/scripts/cdp.mjs gateway native.session.list '{}'
node apps/command-center/scripts/cdp.mjs gateway gateway.performance.get '{}'
```

The helper takes the explicit `FARMSLOT_GATEWAY_PROFILE`. A checkout-local CLI invocation with `--gateway <existing-profile> rpc <method> <json>` is the alternative. Keep inventory reads separate from the measurement window; retain before/after performance snapshots from the same boot without resetting collectors.

## Samples

Collect at least 20 eligible samples per declared metric/target/client cell. Start with the pilot; do not claim all-node or all-runner coverage from it.

| Metric                   | Same-clock boundaries                                                                                                                                    | Procedure and evidence                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keypress to first token  | Actual submit key/touch to first painted nonempty assistant text for that command, on the client monotonic clock. Record first event arrival separately. | Warm one owned session. Send a fixed short no-tool prompt in 20 serial turns, matching persisted command/turn receipts and committed `text.delta`. Exclude echoes, reasoning, status and old text. Separate CC from Companion and cold launch from warm turns. Keypress-to-event includes provider plus delivery time; event-to-paint isolates rendering.                                                                                   |
| Dispatch to worker start | User dispatch request sent to first structured worker-start observation, on one observing client clock.                                                  | Use 20 serial `run.create` fixtures through real write-task, prepare and dispatch. This user-visible total includes admission, queue and preparation; report those recorded stage durations separately. Match run/context/lease/generation and authoritative acceptance/start evidence, never pane text. Cancel after startup, confirm closeout, archive and clean only the owned fixture. A missed start boundary is unmeasured, not zero. |
| Capture/inspect          | Network demand to validated result returned, on the requesting client monotonic clock.                                                                   | Make 20 native inspect/read calls and 20 tmux captures on fixed idle fixtures; repeat with a stream active. Exercise an existing screen/device capture operation where available. Resolve method/parameters from the selected registry and assert session/generation or frame identity and bytes. Keep capture, inspect and cached paint separate.                                                                                          |
| SSH commands per run     | Actual SSH executions from before create through confirmed cleanup, attributed to the owned run.                                                         | Use the same startup fixtures. Record managed `kind=ssh` counter deltas and a complete descendant exec observation on gateway and target. Count invocations even with ControlMaster. Separate node-control SSH, VCS transport, provider/user tools and operator collection. Include scp/rsync SSH transport. Never call a managed-only lower bound the total.                                                                               |

Use the shared performance recorder and existing CDP/device tracing. Observer-only key, event and render listeners may measure real interactions; do not inject application state or add RPC endpoint timers. Do not subtract wall clocks across hosts.

For complete SSH coverage, first qualify an already-authorized OS exec observer that follows process ancestry and reports dropped events. On macOS, an existing `sudo -n fs_usage -w -f exec` setup is one candidate; verify its fields and coverage before use. A controlled owned child executing SSH must be observed, and a no-SSH control must stay empty. Retain executable, timestamp, PID/lineage and run attribution only. If privilege, lineage or coverage is missing, label the total unmeasured. Do not install tracing tools or weaken system protections for this check.

## Verdict

Save raw samples, errors/timeouts, counts, p50/p95/max, bytes, managed spawns, node wait, SSH categories, source and load. Keep failures visible. Shared budgets remain 250 ms for interactive reads/received-text paint and 100 ms for cached paint, with 20 samples and at least 95% within the exact budget bucket. No absolute provider-first-token or startup budget is invented here.

Compare the same pilot workload behind the rollout flag. Require improvement in the targeted path and zero gateway-to-node control SSH per run outside bootstrap/upgrade or recorded operator fallback. Report VCS/provider SSH separately rather than silently subtracting it from the raw total. If the baseline already has zero control SSH, report that fact; do not claim a reduction.

After implementation, run separate fault windows for reconnect/resume, duplicate command delivery, cancellation, expired offsets, slow consumers and bulk-transfer interference. Prove no duplicate side effects or rendered gaps. Save cleanup receipts, compatibility/capability readbacks and the largest measured costs. Rollout readbacks on the remaining nodes follow the accepted amendment; they do not replace pilot measurements.
