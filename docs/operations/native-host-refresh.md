# Refresh a native host

A native host is the detached supervisor and host process that runs native runner sessions. It keeps running across gateway and node restarts. After a deploy it can be left on the previous runtime. New launches, resumes and transfers then fail with `NATIVE_HOST_VERSION_SKEW`: "Native host runtime version skew: node X, host Y". Existing sessions stay readable.

## Where hosts live

- Gateway-local host: the gateway's native state directory, `FARMSLOT_NATIVE_STATE_DIR` or `<FARMSLOT_HOME>/native-sessions` (for example `~/.farmslot-dev/native-sessions`). Reviews and other native work the gateway runs for its own machine use it, and so do Command Center chat and the Co-Pilot.
- Node host: `<native state dir>/nodes/<machine>`, started by that machine's node service.

`host.json` in that directory records the host's `pid`, `runtimeVersion` and `runtimeBuild`. `ps -o pid,command -p <pid>` shows `native/supervisor.ts` or `.js` followed by the directory.

## Automatic refresh

- **Node start.** A node refreshes its host before it registers, if every runner has stopped.
- **Gateway start, and any launch on a host on another runtime.** The gateway refreshes its local host when every live session is idle:
  - Idle runners are stopped, and their journals and saved runner identities are kept.
  - The next host marks those sessions for resume. Warm reviewers, review fixes and messages to a worker then resume them on their own. A Command Center chat shows its resume action. The Co-Pilot starts again from Command Center.
  - An active run's dev worker and static review workspace count as busy even when idle, because their next step would need a person.
  - A session with a turn, approval or other request in flight is busy too.

A host with a busy session keeps running. New launches fail, and the error lists the busy sessions. Once they finish, the next launch refreshes the host.

## Manual refresh

Use this when a host must be refreshed before its busy sessions end on their own, or to inspect one. Run it from a checkout of the deployed revision, on the host's machine, as the same user:

```sh
node --import tsx scripts/native-host-refresh.mts --root ~/.farmslot-dev/native-sessions
node --import tsx scripts/native-host-refresh.mts --root ~/.farmslot-dev/native-sessions --machine macwork
```

It prints the host's runtime and each live session, with its state, runner, owner and directory. Nothing changes.

1. For each live session, find its run with `farmslot run list` and `farmslot run get <runId>`. Read its journal at `<root>/sessions/<id>.journal` if the owner is unclear: the first prompt names a Co-Pilot or a reviewer. Finish, close or cancel what must not stop. A dev worker or a static review workspace of an active run needs an operator afterwards.
2. `--refresh` retires the host only if every runner has stopped. `--refresh --stop-idle` also stops idle runners, keeping their journals. A busy session still blocks it, and the output names it.
3. The script never starts a host. The next native launch from the gateway or node starts one on the current runtime, from its own process and environment. Check the new `host.json`: a new `pid`, and `runtimeVersion` equal to the deployed version.

Do not kill the supervisor or host processes by hand, and do not edit `host.json` or journals. The supervisor's own shutdown stops each runner and records the cleanup the next host relies on.
