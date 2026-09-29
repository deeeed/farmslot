# Command operation observations

This reference describes optional command observations alongside task progress.
It does not change recipe proof results or checklist completion.

Command runtimes may use `OperationRecord` from
`@farmslot/recipe-harness/runtime/operation`. Each invocation writes a UUID-named
record and log. Nested invocations carry a `parentId`; they do not overwrite their
parent. The producer calls `stage`, streams output with `output`, and calls
`finish` with the real exit code. Records include process identity, start time,
last output time, stage start time and a periodic producer heartbeat.

When a command belongs to a running task, the producer mirrors its records into
`artifacts/operations/` and writes `artifacts/operations-updated.json`. The existing
task watcher projects these records through `task.progress`. Command Center shows
reported execution and freshness, with links into the shared artifact viewer.
The log viewer reads the latest 64 KiB and offers explicit refresh or follow.
Full logs remain on the producing node. The raw artifact route retains its existing download size limit; following a log uses bounded node reads even for larger files.

A heartbeat proves the producer reported activity. Log output proves bytes were
written. Neither establishes application health, forward progress or a passing
acceptance criterion. Missing updates remain visible as missing updates.
Observation records do not grant mutation authority: runtimes retain their
existing checkout locks and Farmslot retains device leases. Status readers and
log viewers neither take those locks nor refresh producer activity.
