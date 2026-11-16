All agent instructions are in [CLAUDE.md](CLAUDE.md). Read that file — it applies to all runners.

## Performance rules

Every runtime change (gateway, node, Command Center, Companion, prepare and dispatch) follows these. The process, tracked metrics and baselines are in [docs/operations/performance.md](docs/operations/performance.md).

1. No call whose cost grows with run size. A per-call loop over all runs, all records or all files is a defect; index or bound it.
2. No new polling loop when an event exists. Subscribe to the change notice, watcher or stream instead.
3. A hot-path change states the processes and Git calls it adds or removes per call.
4. Batch node-side Git in one execution: one trusted node command per inspection, not one per Git call.
5. Every performance claim carries before/after numbers from the operation log or process + Git counts per call, measured the same way on the same workload.
