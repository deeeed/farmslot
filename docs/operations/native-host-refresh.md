# Refresh a native host

A native host is the detached supervisor and host process that runs native runner sessions. It keeps running across gateway and node restarts. After a deploy it can be left on the previous runtime. New launches, resumes and transfers then fail with `NATIVE_HOST_VERSION_SKEW`: "Native host runtime version skew: node X, host Y". Existing sessions stay readable.

## Where hosts live

- Gateway-local host: the gateway's native state directory: `FARMSLOT_NATIVE_STATE_DIR`, or `<FARMSLOT_HOME>/native-sessions` (legacy layout, for example `~/.farmslot-dev/native-sessions`), or `<FARMSLOT_HOME>/state/native-sessions` (newer layout). See [farm paths](farm-paths.md). Reviews and other native work the gateway runs for its own machine use it, and so do Command Center chat and the Co-Pilot.
- Node host: `<native state dir>/nodes/<machine>`, started by that machine's node service.

`host.json` in that directory records the host's `pid`, `runtimeVersion` and `runtimeBuild`. `ps -o pid,command -p <pid>` shows `native/supervisor.ts` or `.js` followed by the directory.

## Automatic refresh

- **Node start.** A node refreshes its host before it registers, if every runner has stopped.
- **A launch, resume or transfer on a node host on another runtime.** The node refuses the launch as skewed. The gateway then sends it once more with its release list: the node owner's sessions bound there in runs that no longer keep them, by the same rules as below. An ensure's own session is never on it. The node refreshes its host before the launch when every live session is idle and released:
  - It stops idle runners only on a host with the idle-runner fence, and at most 6 of them, so the launch normally finishes within its 160 s timeout. With more idle runners, or on a host without the fence, every launch is refused until you close sessions or refresh the host by hand (below); the error says which.
  - A session the list doesn't name keeps the host: another owner's, a Command Center chat or standalone session, one started after the list, and an active run's own worker or static review workspace. The error names each with its reason.
  - A launch that waited for another refresh is refused rather than use its older list; the next one sends a fresh list.
  - Only nodes that declare `supportsHostRefresh` get the list. An older node refreshes only at its own start.
  - Residual risks: a session released when the list was sent can be claimed by a run before the stop, and is stopped anyway. Its next use resumes it, or a person must if it became a run's own worker, CI fix or static review workspace. The host's fence checks busy state, not the list, so a launch the host held from before a node restart that finishes in between leaves an idle unlisted session that is stopped too.
- **Gateway start, and any launch on the gateway's local host on another runtime.** The gateway refreshes its local host when every live session is idle:
  - Idle runners are stopped, and their journals and saved runner identities are kept. At startup the gateway then starts the current host.
  - The next host marks those sessions for resume. Warm reviewers, review fixes and messages to a worker then resume them on their own. A Command Center chat shows its resume action. The Co-Pilot starts again from Command Center.
  - Some idle sessions of an active run count as busy, because their next step would need a person: its own worker (`primary`, `dev`, `fix-bug`), a CI fix and a static review workspace.
  - A session with a turn, approval, compaction or other request in flight is busy too.
  - A request from the gateway that adds work (a launch, a message, a compaction) and is already on its way to the host also holds it.
  - Hosts from this version onward fence admissions and new input atomically before they stop, and name any session that is still busy. If the stop doesn't follow within a minute, the fence lifts. An older host can't be fenced while a runner is live; the gateway relies on its own census and request count. A legacy host with no upgrade fence at all is stopped the same way once its sessions are idle. A request from another process on the same state directory, such as the manual script below or a CLI command pointed at the gateway's root, could still reach it in between.

After a checkout update, a gateway that hasn't restarted yet runs older code than its checkout (it reads its own build when it starts). It refuses to refresh then, because a host started from the checkout would be skewed against it too, and the error says to restart the gateway.

A host with a busy session keeps running. New launches fail, and the error lists the busy sessions. Once they finish, the next launch, or the next gateway start, refreshes the host. A node host is refreshed the same way at its next launch, within the limits above. Nothing refreshes a host between launches, and a node start that found busy runners doesn't check again later, so a node host stays on the old runtime until its next launch or node start. A live dev worker of an active run keeps a node host for as long as it runs.

A launch that refreshes a host takes longer than usual: up to a minute plus 15 s per idle runner. Command Center (15 s) and Companion resume (30 s) can time out first and show an error for a session that was in fact created; refresh the view before retrying.

## Manual refresh

Use this when a host must be refreshed before its busy sessions end on their own, or to inspect one. Run it from a checkout of the deployed revision, on the host's machine, as the same user:

```sh
node --import tsx scripts/native-host-refresh.mts --root ~/.farmslot-dev/native-sessions
node --import tsx scripts/native-host-refresh.mts --root ~/.farmslot-dev/native-sessions --machine macwork
```

It prints the host's runtime and each live session, with its state, runner, owner and directory. Nothing changes.

1. For each live session, find its run with `farmslot run list` and `farmslot run get <runId>`. Read its journal at `<root>/sessions/<id>.journal` if the owner is unclear: the first prompt names a Co-Pilot or a reviewer. Finish, close or cancel what must not stop. A dev worker or a static review workspace of an active run needs an operator afterwards.
2. `--refresh` retires the host only if every runner has stopped; otherwise it says live runners remain. `--refresh --stop-idle` also stops idle runners, keeping their journals. A busy session still blocks it, and the output names it. On a host older than this version, `--stop-idle` can't fence the gateway: a message the gateway sends at that moment would be lost. Run it while the gateway is stopped, or when nothing is using the host.
3. The script never starts a host. The next native launch from the gateway or node starts one on the current runtime, from its own process and environment. Check the new `host.json`: a new `pid`, and `runtimeVersion` equal to the deployed version.

Do not kill the supervisor or host processes by hand, and do not edit `host.json` or journals. The supervisor's own shutdown stops each runner and records the cleanup the next host relies on.
