# Graph-owned planning retry

Owner: gateway graph mutation/scheduler. Authority: ADR-040 and its graph-owned
retry amendment. This contract covers plan authoring around retained work;
it does not reset, attach or dispatch a run.

## Admission and retained state

`workGraph.retry` accepts `{graphId, reason}`. `reason` MUST contain nonempty text; its stored value is trimmed. It returns the existing `WorkGraphProjection` with graph status
`planning`. Paused, needs-attention, done and failed graphs are eligible. Active
or waiting graphs MUST first be paused. Archived graphs MUST be refused, because
retry cannot reclaim backlog membership from another graph. An already-planning
retry is idempotent and does not create another history entry.

The operation MUST retain graph identity/source, all nodes and their statuses,
node/run/family/backlog links, edges and evidence, gate resolutions and the
entire action ledger. It MUST NOT change run, queue, backlog or slot records.
It MUST append `{reason, previousStatus, retriedAt}` to optional
`graph.retryHistory` in the same persisted graph snapshot. Missing history in an
older v1 snapshot means no recorded planning retry, not a second contract.

Use the existing serialized graph mutation lock. Persist the candidate snapshot
before making the new planning state visible or broadcasting it. A failed write
MUST leave the old state visible. Concurrent activation, pause, authoring and
scheduler calls use that same owner and see a complete transition.

## Scheduling and authoring

Planning, paused and archived graphs MUST remain unchanged under background or
targeted scheduler ticks, including operator force-enqueue. Only explicit
`workGraph.activate` admits a planning graph to scheduling. Retry does not revoke
work already admitted; in-flight runs may continue and finish.

Existing add-node/add-edge commands author the revised plan. One-live-graph
backlog membership remains enforced. In a retried graph, node removal MUST refuse
nodes with recorded run/family/queue/backlog attempt or action-ledger facts;
removing newly authored, unexecuted nodes remains supported. No implicit unlink,
reset or replacement may bypass these guards.

## Public surface

- CLI: `farmslot graph retry <graphId> --reason <text>`, with existing JSON output.
- RPC: admin-only `workGraph.retry`; typed `WorkGraphRetryParams` and
  `WorkGraphRetryResult` from `@farmslot/protocol`.
- Projection: optional `WorkGraph.retryHistory` containing `WorkGraphRetryRecord`.
  CLI/gateway clients inspect the same stored records; no new audit store exists.
- Compatibility: additive v1 method/fields. No changed runner/model defaults or
  new harness/recipe configuration. Harnesses inherit existing queue admission.
