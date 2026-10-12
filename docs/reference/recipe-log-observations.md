# Recipe log observations

**Status:** Accepted under [ADR-034 Amendment 2](../adr/034-recipe-protocol-v1.md#amendment-2-2026-10-12-bounded-log-observations).
**Lifecycle:** Retain as the normative contract after approval.
**Implementation:** Merged in [#969](https://github.com/deeeed/farmslot/pull/969).

## Public surface

The existing `watch_logs` action accepts optional `timeout_ms`, an integer from 0 through 60000 milliseconds. Recipes and `farmslot recipe call watch_logs` pass it through existing parameter handling. `@farmslot/recipe-runner` owns execution. Providers and libraries exposing this field MUST require the supporting protocol and runner versions and declare it in their manifests. No new action, CLI flag, SDK export or evidence format is introduced.

The optional window is a backward-compatible action extension. Rejecting
output-derived run-scoped paths is a breaking correction to stale-content false
passes. Provider catalogs and supporting protocol/runner dependency pins MUST
move together. Existing project lifecycle callbacks remain unchanged. The merged
PR records source delivery; package publication and provider rollout are separate.

## Behavior

- Omitted or zero `timeout_ms` MUST retain one immediate check. The run-scope correctness rules below apply in every mode; existing stale-content false passes are not compatibility guarantees.
- A positive value MUST require nonempty `contains`. Preflight MUST reject invalid statically resolved values and a positive window without a condition. Output-dependent values MUST be validated before this node reads files; they do not permit preflight to execute upstream producers.
- The action MUST observe the selected file until the substring matches, the window expires, or the run is cancelled. It MUST NOT start another poll after its budget expires. Cancellation MUST interrupt a pending wait and retain `RECIPE_ABORTED` classification and authored teardown. The interval MUST be 100 ms or the remaining budget, whichever is shorter. An in-flight filesystem read may finish after the observation budget; it MUST NOT permit another poll.
- Polls MUST use the existing contained file reader. A missing file may appear during a positive window. Other read or containment failures MUST surface immediately.
- `scope=run` MUST capture initial offsets for statically resolved root and per-call-instance paths before any producer runs. Defaults and call parameters MUST be resolved through the existing invocation machinery, with one offset per resolved path. Output-derived paths MUST use explicit `scope=file`; a run-scoped path without a captured baseline MUST fail before reading. `scope=file` starts at zero. Observed truncation below the offset rebases it to zero for the remaining observation. This corrects the current raw-template-path fallback; prior content cannot satisfy a run-scoped match.
- Polling MUST NOT launch, restart, reload, clear, rewrite or repair the application or its logs.
- Success MUST retain the existing `path`, `matched`, `scope`, `offset` and `bytesScanned` output fields. An unmet condition at expiry MUST fail as a subject assertion. Attempts are observations inside one node, not successful retries of the producer.

```json
{
  "action": "watch_logs",
  "path": "logs/service.log",
  "contains": "service ready",
  "timeout_ms": 2000,
  "scope": "run",
  "intent": "Observe startup readiness within the declared window",
  "next": "done"
}
```

## Acceptance

A real producer appending readiness after the first check MUST pass within a positive window and fail under immediate mode. A missing marker MUST fail; cancellation MUST stop promptly. New tests MUST include called/parameterized preflight, existing-output compatibility and stale-run-content refusal, with no fixed waits of one second or more.

Acceptance MUST cover delayed append and file creation, immediate checks, timeout,
cancellation, scope isolation and preflight rejection through public CLI execution
with a real filesystem producer. Unit cases MUST remain below five seconds.

## Owning paths

- `packages/protocol/src/recipe/document.ts`: shared `validateOfficialActionRelationships` checks the conditional requirement, timeout bound and known output-derived run paths. Keep unresolved output values deferred. Existing resolved-action validation applies the same rule before node I/O.
- `packages/recipe-runner/src/core/trust.ts`, `runner.ts`, `compose.ts`: validate every statically resolved invocation before effects and capture its log paths before producers run. Reuse the existing parameter/call traversal; do not add a second resolver. Verify recipe-cli static validation and runner CLI consumers of the same protocol checks.
- `packages/recipe-runner/src/adapters/core.ts`: one contained reader/poller; preserve immediate results, cancellation and failure classification.
- MetaMask `library/manifests/{core,mobile,extension,web-dapp}.action-manifest.json`: expose the optional field. `src/adapters/web-dapp/actions.ts` supplies the web-dapp catalog inherited by Terminal. The Terminal library adds domain actions only; `@farmslot/adapter-web` itself ships no action manifest.

Tests cover root/default/called parameters, output-derived path refusal versus explicit file scope, initial stale content, truncation, expiry, cancellation and existing immediate output. Protocol and runner releases plus affected provider/catalog dependency pins are coordinated separately after implementation review.
