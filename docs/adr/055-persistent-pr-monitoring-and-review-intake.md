# ADR-055: Persistent PR monitoring and review intake

**Status:** Proposed, implementation authorized; validation pending
**Date:** 2026-09-09
**Scope:** [Monitoring and trigger rules](../PRD-automation-intelligence-canonical.md#6-persistent-pr-monitoring-planned), [execution plan](../plans/persistent-pr-monitoring.md)
**Related:** [ADR-028](028-pr-dashboard-github-quota.md), [ADR-044](044-backlog-launch-plans.md), [ADR-051](051-principal-and-credential-model.md), [ADR-053](053-run-lifecycle-transition-routing.md)

## Context

Run-scoped CI watching stops being useful when a completed run releases its slot. Reviews and conflicts can arrive days later. Dashboard discovery from historical runs also expires. Teams need durable subscriptions for any accessible PR and rules that collect review work from repository or Project criteria.

## Decision

### Gateway owns durable monitoring

Store PR identities, subscriptions, observations, incidents, team profiles, rules and review intents independently of runs. A subscription never needs a placeholder run or occupied slot. Keep subscription lifecycle, provider freshness and action state separate.

Identify a PR by provider host, repository and PR number. Retain provider repository IDs when resolved so renames can be reconciled. Distinct access contexts must not share cached private facts merely because a PR key matches. A team's subscription interest and notification audience are separate from canonical PR identity and execution ownership.

Use versioned records and serialized atomic persistence before acknowledging mutations. Persist source cursors, incident revisions, notification delivery attempts and admission links. Broadcast changes after persistence. Restart reconciliation restores unfinished operations using their durable keys.

### Observation is independent of response policy

A gateway scheduler polls through the shared GitHub request budget and cache. Provider events request reconciliation through the same path. PR head, base mergeability, reviews, threads and check attempts retain source identity and freshness. Missing permission, incomplete pagination and provider failure are unknown coverage, never a healthy result.

Rule discovery persists a traversal scoped to its principal, credential fingerprint and team/rule revisions. Each attempt advances at most 25 connection requests. Record the next connection before enforcing the budget; incomplete traversals survive restart and low polling cadence. Completed previews remain available until versioned admission consumes them. Policy changes prune abandoned scopes; generation checks fence delayed writes and consumers. Repeated or provider-rejected cursors reset the affected connection and dependent facts, while quota or network failures retain progress.

Saved pages retain their original observation window. They do not certify current execution eligibility. Acceptance and dispatch read the target PR and its current Project memberships independently of discovery checkpoints; changed-file reads and a final metadata read check the captured head/base. Notifications and monitor enrollment from resumed or stale discovery require fresh target facts matching the admitted source revision. Failed validations wait for retry, and never-attempted actions precede retries so slow failures cannot starve later work. Activation seeds its historical baseline atomically from the complete, revision-checked preview, so PRs discovered after enablement remain future changes.

Notify-only records attention without scheduling work. Automatic repair admits eligible incidents to ordinary `pr-complete` work. Monitor policy is explicit; Farmslot publication enrollment is opt-in per project. A repair result does not resolve GitHub facts without a fresh observation. Already-handled review revisions do not rearm merely because a worker pushed a commit.

### Typed rules produce durable intents

Team profiles own reusable scope and review policy. Rules bind repository/Project sources and typed all/any/not predicates to Notify, Add monitor or Enqueue review actions. Project field bindings use provider IDs. Saved-view import rejects unsupported conditions before activation; it cannot silently broaden scope.

Imported views retain a snapshot of the original filter and every mapped or unresolved term on their Project source. View filters apply only to that source's non-archived PR membership; independently configured repositories remain separate sources. Unmapped terms or unavailable field/option IDs make coverage incomplete and prevent activation. A field or option rename preserves its ID binding. Refreshing display names does not overwrite saved filters; re-import is explicit.

Repository policy assessments keep supplemental approval counts, GitHub's own review decision, and inactivity separate. Counts use unique latest approving reviewers; configured inactivity compares GitHub's last update with the source observation time. These display observations are persisted in a typed `reviewPolicyFacts` object outside eligibility facts, so adding or removing a policy does not change the admission fingerprint or backfill historical PRs. Counts do not confer merge authority.

Webhooks provide refresh hints. Repository sources can claim a matching repository directly; Project sources require a current targeted membership/view lookup using the team's credentials. Unknown source ownership returns a retryable response and never falls through to legacy dispatch. Scheduling rechecks configuration revisions and relevant owners before recording due scans.

Preview is side-effect free. Rules start disabled, historical backfill is explicit, and review intake defaults to held work. Auto-start requires explicit configuration. Deduplicate by canonical PR, head and review purpose, retaining every contributing rule and team interest. Rule/profile edits revalidate pending work without replaying completed reviews.

Persist Notify and Add-monitor receipts in the same transaction as source admission. Their keys include the rule, source account, PR and observed source revision. Adding an action does not backfill already-matched PRs implicitly. All actions for one newly admitted PR share the per-scan subject budget.

Notify creates durable in-app attention with per-recipient acknowledgement. Only the owner and explicitly selected, currently authorized recipients can read it; sharing attention does not share the rule's private source facts or policy controls. Push delivery is separate from acknowledgement and must not remove the durable item on failure.

Remote delivery uses Expo's push service with per-installation registration and durable tickets. Android delivery requires FCM configuration in the native build and a sending credential in Expo's managed credentials. Keep downloaded configuration and private keys outside the checkout; supply the native configuration path through `GOOGLE_SERVICES_FILE`. The public repository contains the integration contract only.

Registration updates use a revision check so a delayed token refresh cannot undo an explicit opt-out. Token generations distinguish replacement tokens from preference changes. A rejected old-token receipt and concurrent registration reconcile within one persistence transaction. Confirmed transient rejections retry with bounded backoff; an interrupted send whose acceptance is unknown remains visible without blind replay. A successful provider receipt confirms handoff to the platform push provider, not that a person saw the notification. Device evidence is required for that delivery claim.

Monitor enrollment rechecks the captured rule/team revisions and authority inside the serialized subscription mutation. Completion records the resulting subscription ID. A crash between subscription persistence and receipt completion replays against the existing subscription identity. Duplicate enrollment preserves the existing policy and lifecycle, including an explicitly stopped monitor. Disabling a rule withdraws pending enrollment; an already-created subscription has its own lifecycle.

### Existing dispatch queue owns execution

Reuse ADR-044 exact/pool slot constraints and the shared runner model/effort capability contract. An execution profile restricts the allowed slot/model combinations; alternatives select one execution rather than expanding comparison candidates. Busy slots wait. Invalid configuration requires attention. No unlisted fallback is permitted.

Keep one durable admission key through intent, queue entry and resulting run. Reconcile a crash after queue/run creation from that key before retrying. Revalidate source state, current policy, originator authority and execution constraints at the queue's run-creation boundary. Incompatible constraints from deduplicated rules hold the intent for resolution.

Use canonical PR ownership across review, repair, CI-watch and manual runs. Observations continue during execution. Admission cannot launch competing work on the same PR; a review binds to the resulting head after an active repair. Preserve existing queue claims, host-pressure admission and lifecycle routing. Do not add a second slot allocator.

### Reviewer sessions use existing continuity contracts

Automated intake uses the same Continue/Fresh and validation-depth controls as manual reviews. Follow-up rounds default to continuing the compatible reviewer session; full independent reviews reset it. Reuse the existing repeat-review chain, native session references and runner adapters, with explicit fallback reasons when continuation is unavailable. Preserve prior findings and reviewed SHA without carrying a verdict to an unreviewed head. Warm sessions do not reserve slots or bypass PR execution ownership.

Store artifact-only review results on the run independently of publication decisions. Require a successful worker completion signal, the pre-dispatch commit snapshot, and a copied review report before recording the result. Completion must preserve those original inputs. Intake status and continuation history use the same stored result; replaying worker execution clears it, while replaying completion preserves it.

Keep sessions attached to PR review history when slots rotate among tasks. A pool can review A, review B, then reload A's saved session for its changed head. Continue waits for the prior compatible slot by default; configurable available-slot fallback can trade that reuse for an earlier fresh start.

### Authority follows the originating principal

Persist execution authorship under ADR-051 and re-resolve it before deferred work. Revocation prevents future starts. GitHub author identity, team criteria and notification audience do not grant execution authority. Provider credentials stay gateway-side; profile payloads contain references only.

Team profiles configure scope and audiences within existing gateway authorization. They do not create a new role or override ADR-051's default-deny rules. Access-filter observations, details and notifications through the same authority boundary. Never expose facts across credential contexts through shared-cache or deduplication responses.

### Clients share the same records

Command Center and Companion display monitor incidents, rule matches, held/queued/running work, requested and actual slot/model assignments, and precise waiting reasons. Mutation responses and broadcasts carry authoritative state. Push notifications link to current incident state; delivery failure leaves the in-app incident intact. Reconnect refreshes records before actions are offered.

### Integration packages stay outside core execution

Human submissions and automatic discovery feed the same review-intake contract. A request selects a PR, team/project policy and review depth, including full live QA, and carries an idempotency key plus source/requester references for audit. Farmslot owns validation, admission, execution and results. External requester references do not grant gateway authority.

A Slack app can implement that contract as an optional, separately deployed integration. It owns Slack credentials, channel/member checks, commands, modals and thread replies. It connects through an authenticated Farmslot API client with explicit submission/auto-start policy. A Slack outage cannot stop gateway execution or hide its results. Core code has no Slack SDK, channel IDs or team-specific message parsing.

Start with an ordinary external API client. An in-process plugin host or general connector framework is not required by this feature. Building and installing the Slack app is a separate delivery scope; the reusable intake boundary belongs here.

## Alternatives

- Extending completed runs or retaining their slots couples observation to execution and repeats the original problem.
- Polling from each client loses coverage when clients close and duplicates provider traffic.
- Dispatching directly from webhooks bypasses durable deduplication, profile checks and queue ownership. Rule-enabled webhooks must feed the shared admission path.
- Adding another scheduler for review slot allocation duplicates existing queue policy and makes competing PR workers harder to prevent.

## Validation and consequences

The implementation adds durable state and cross-store reconciliation work. Atomic file replacement alone does not guarantee exactly-once dispatch; admission keys and run-creation checks must prove crash recovery.

Completion requires the PRD's PM-1 through PM-12 and TR-1 through TR-18, with real gateway evidence, Command Center CDP flows and Companion recipe validation. Include restart replay, policy revocation, cross-team deduplication, slot/model conflicts and reviewer continuation. Independent and cross-model review must inspect the final implementation. This ADR remains proposed until those checks establish the implemented contract.

Scheduled summaries, additional issue-tracker adapters, package-release detection and automatic merge remain outside this implementation.
