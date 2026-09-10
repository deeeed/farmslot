# Farmslot — Automation, Intelligence, and Orchestration Canonical PRD

This canonical chunk PRD defines Farmslot's automation, intelligence, and orchestration layer under [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and [PRD-product.md](PRD-product.md). It captures the product contract for persistent run handling, monitoring, automation, and LLM-assisted improvement loops.

## Scope

This chunk owns the logic that turns the core platform into a persistent supervised automation system:

- gateway-mediated run creation and workflow state management
- persistent monitoring, decision queues, and auto-recovery behaviors
- queueing, webhook-triggered work, notifications, and completion pipelines
- scoring, task writing, self-review, co-pilot, and related LLM-assisted flows
- self-improvement and observability loops that feed future system changes

## User Outcome

An operator should get less manual toil and better evidence-backed supervision because runs can be graded, queued, monitored, nudged, reviewed, and improved through persistent product workflows instead of fragile session-only behavior.

## Canonical Current State

- The automation layer is already part of the shipped product through queueing, webhooks, notifications, and persistent daemon behavior.
- The intelligence layer is already active through multi-provider LLM support, self-review, task writing, and co-pilot features.
- The self-improvement and run-family observability surfaces are active architectural concerns reflected in recent ADRs.
- The bugfix local-first publication gate is shipped, giving automation a human-approved publication boundary with review-depth provenance before public PR mutation.
- The active next automation slice is eval-package template regression: derive a reference package from a merged PR/prior run/package/git ref, produce candidate packages from artifact-only comparison-lane runs, persist `EvalExperimentManifest` + `ResultPackageManifest`, and compare package diffs, visuals, validation evidence, review signals, timing, and cost so prompt/template/harness changes can be evaluated without creating a new merge-intended PR. This extends the existing run-family/lane/run model rather than introducing a competing line or replay taxonomy.

## Requirements

### 1. Persistent run ownership

Dispatch flows must be represented as persistent runs with recoverable state rather than ephemeral session-only chains.

### 2. Monitoring and decisions survive restarts

Monitoring, nudges, pending decisions, and recovery hints should survive normal workflow interruptions and remain visible to operators.

### 3. Automation remains supervised

Queueing, auto-recycle, self-review, and improvement proposals should reduce toil while keeping human approval and evidence review in the loop.

### 4. Intelligence uses shared product evidence

Scoring, grading, summaries, co-pilot, and self-improvement flows must rely on the same task/run/artifact evidence model rather than ad hoc per-feature data silos.

### 4.1. Logging is typed evidence

Gateway intelligence should answer from structured run state and step artifacts first. Logs are still a useful tool for the main gateway intelligence, especially for self-diagnosis of gateway/runtime failures, parser drift, prepare-script failures, and artifact gaps. When logs are needed, Co-Pilot and read-only investigation workers must consume them through scoped, bounded, redacted registry entries rather than ad hoc filesystem reads.

### 5. Cross-surface consistency

Desktop, mobile, CLI, and future surfaces should observe the same run and decision model.

### 6. Persistent PR monitoring (planned)

**Status:** proposed product contract, captured 2026-09-09. This is not implemented by the existing PR dashboard, `ci-watch`, or `pr-complete` flows. Project enrollment is opt-in as confirmed by the operator; other defaults below are proposed. Implementation needs a reviewed delivery spec.

#### Outcome and ownership

An operator can subscribe to a PR for days or weeks, release its farm slot, and still learn when a reviewer requests changes, checks fail, or the branch develops a conflict. The PR can come from a Farmslot run or be an externally created PR by any author. The gateway owns monitoring while it is online; neither an open client nor a running worker is required.

A **PR monitor** is a durable subscription, independent of a Run. A **monitor incident** records an actionable condition and the response to it. A **repair run** is ordinary queued work, normally `pr-complete`, launched for an incident. Completing a repair run does not end the subscription or make unresolved GitHub conditions healthy.

The monitored PR queue and the dispatch queue serve different purposes. Healthy PRs remain in the watch queue without consuming slots. Only requested or policy-authorized repairs enter the existing dispatch queue. A completed originating run stays completed; late feedback never revives it just to keep watching the PR.

#### Subscription and policy

Operators can add a PR URL from either client, choose Monitor PR from a run or PR page, and pause, resume, change policy, or stop an existing monitor. No authored-by-me filter is allowed. Read access through the selected GitHub account is sufficient for notify-only monitoring, even without a configured Farmslot project or prior run.

Identity is GitHub host, repository identity, and PR number, with a canonical URL for display. PR numbers alone are never keys. Adding the same PR again returns its existing monitor without silently changing its policy; two repositories' PR #123 remain separate. Each monitor records its owner, credential reference, optional project and originating-run links, effective policy, and a policy revision. Access and action authority come from gateway principals and GitHub permissions, not from the PR author's identity.

| Policy           | What happens when an eligible issue appears                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notify only      | Persist an incident, show it in both clients, and send configured notifications. Do not allocate a slot, launch a worker, or change the PR. The operator can request repair from the incident. |
| Automatic repair | Persist the incident and enqueue one repair run using the selected project, runner/model, and workflow policy. Show the queue entry and eventual run in both clients.                          |

Policy is explicit at subscription time and editable later. **Confirmed enrollment policy:** opt-in per project for PRs published by Farmslot. New project enrollment starts with notify-only unless an operator explicitly selects an automatic-repair policy, with per-PR overrides. Manual URL subscriptions are always available. Publication success can enroll an opted-in PR idempotently; run completion, slot release, or client disconnect must not remove it. Project policy edits apply to future enrollments unless an explicit bulk change is previewed and confirmed. Enabling a project policy does not silently import all historical PRs. A separate explicit import can select existing PRs.

Automatic repair requires a configured project/repository mapping, an authorized execution identity, and a supported writable branch path. Readable third-party PRs remain monitorable when these requirements are absent. Fork PRs without write permission become Needs action with the concrete reason; the system must not silently push another author's branch, create a substitute PR, or assume PR authorship grants permission. A user choosing automatic repair explicitly authorizes that repair workflow within the selected project policy. It does not grant automatic merge or bypass existing review, publication, or credential rules.

At enrollment, show a baseline summary of existing actionable issues. Notify-only creates one initial attention item for them. Automatic repair may handle that initial set when its configuration is complete; the enrollment view must show that it will queue work immediately. Thereafter, alert on changed conditions rather than replaying historical events on every refresh.

#### What monitoring detects

| Condition                                                     | Required behavior                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review changes requested, including human reviews             | Record the review revision and outstanding request. Evaluate review dismissals and later approvals so resolved requests do not remain actionable.                                                                                                       |
| New or edited actionable review feedback                      | Track review threads and configured bot findings, including resolution and edits. Routine bot chatter and arbitrary comments do not automatically authorize code changes. Comment text remains task input, never authority to change monitoring policy. |
| Relevant CI failure or regression                             | Use configured watched checks for actions; also expose the complete GitHub check summary. Distinguish failure, cancellation, pending, skipped, and unknown. A new commit's pending checks are not failures.                                             |
| Merge conflict appearing after base-branch changes            | Re-evaluate mergeability even when the PR head does not move. Unknown mergeability is retried and displayed as unknown, not treated as a confirmed conflict.                                                                                            |
| PR merged or closed                                           | Stop automatic observation/actions and retain history. Reopening requires an explicit resume in V1. Queued repair work must re-check that the PR remains open before starting.                                                                          |
| Provider unavailable, credentials revoked, or quota exhausted | Keep the last confirmed facts, expose stale/access-lost state and retry timing, and stop new repairs until fresh authorization and observations are available. Never report healthy because a read failed.                                              |

Issue acknowledgement, GitHub resolution, and successful repair are separate facts. Acknowledging a notification does not clear a failing check or a changes-requested review. A no-change repair can mark a particular comment revision handled, with evidence, without asserting that CI passed. Dependency blockers become Waiting on dependency with a reason and a resumption condition or explicit manual-resume instruction. They must not create an endless sequence of identical repair runs. Detecting package releases is not part of this PR-monitoring V1.

#### Durable scheduling and duplicate prevention

- Persist monitor configuration, observations, incident fingerprints, notification delivery state, and queued/running repair links. Restart resumes the same records. Notification delivery failure must not lose the incident or hide it from the in-app inbox.
- Poll from the gateway using the shared GitHub cache, batching, quota and retry machinery. Proposed default cadence is five minutes, configurable within the provider budget. Webhooks may accelerate refresh when available; a public webhook endpoint is not required. Clients show last successful check, last observed change, and next scheduled check separately.
- Share observations between monitoring and existing PR/CI readers. Opening Command Center and Companion together must not double GitHub requests or repair dispatches. A long-lived watch never ages out because its originating run passed the dashboard's terminal-run retention window.
- Reconcile missed changes after gateway downtime against current GitHub state and persisted history. A disappeared transient issue need not produce a repair. A still-actionable new review must be detected after reconnect. Downtime and rate limiting are visible gaps in coverage, not continuous-monitoring claims.
- Use source identities and revisions for incident deduplication. Advancing the PR head during repair must not rearm an unchanged changes-requested review. New check attempts and edited/new review feedback remain eligible; an already-handled comment revision does not.
- Coalesce concurrent eligible incidents for one PR into one queued repair request. At most one automatic queued or running repair owns a PR at a time. Persist queue admission and run linkage so a crash between enqueue and recording the run cannot duplicate work.
- Coordinate ownership with existing `ci-watch`, `pr-complete`, and manual runs for that PR. Monitoring continues while a repair owns execution, but does not start a competing worker. New incidents stay visible and are reassessed after the active work finishes.
- Dispatch through the existing queue and slot/host-pressure admission path. Re-check policy revision, PR state/head, issue relevance, project mapping, credentials, and branch-write authority before execution. Superseded work is cancelled or updated before it claims a slot.
- Apply per-monitor cooldown and attempt limits. Proposed default is at most two automatic repair attempts for an unchanged incident before Needs action. Failed delivery, no push, failed validation, and a genuinely new issue must remain distinguishable in the history.
- Pausing or switching to notify-only prevents future automatic starts and withdraws monitor-owned work that has not started. An already-running repair remains a normal run, visibly linked; cancelling it is a separate explicit action. Stopping a subscription does not delete its PR or originating run.

#### Client contract

Command Center and Companion consume the same gateway records, incidents, decisions, and events. An imported PR must appear without inventing a dummy run or slot. The shared decision model must support a monitored-PR subject even when no run exists yet.

Both clients provide a Monitored PRs queue with search/filtering by repository/project, author, policy, and attention state. Unmapped external repositories remain visible. Each row shows PR identity, author, policy, observation freshness, outstanding reason, queued/active repair, and the next available action. Subscription lifecycle (active/paused/stopped), observation health, and action state are separate, so a paused watch, stale provider, healthy PR, and blocked repair are not all labelled Waiting.

Required attention states include Healthy, Needs action, Queued, Fixing, Waiting on dependency, and Finished (merged/closed). Show specific messages such as "Reviewer requested changes yesterday", "Conflict detected; repair queued", or "Waiting for a published dependency; no worker running". A stale observation must not erase the last confirmed issue.

The incident detail offers Open PR, inspect triggering evidence, acknowledge or snooze that incident, queue the configured repair, change policy, and pause/stop monitoring. Show why repair is unavailable and what project or permission is missing. Provide links between the watch, its originating runs, and repair runs.

Companion receives push notifications for new actionable incidents when push is configured, with a deep link to the same incident. In-app attention remains available when push delivery fails or permission is disabled. Resolving, snoozing, or changing policy in one client updates the others immediately. On reconnect, clients load current gateway state before offering actions from an old notification. Mutations broadcast authoritative shared updates rather than notifying only the caller.

#### V1 boundaries and acceptance criteria

V1 supports explicit GitHub PR subscriptions, persistent polling, the two response policies, ordinary `pr-complete` repair dispatch, and both clients. Optional project enrollment applies to newly published Farmslot PRs. Automatic merge, bulk scanning every organization repository, package-release automation, arbitrary workflow scripting, and bypassing another author's branch permissions are outside V1.

| ID    | Acceptance criterion                                                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PM-1  | After an originating run is Done and its slot released, a changes-requested review arriving more than 24 hours later creates an incident within one configured poll interval plus one minute, while the gateway/provider are available. No client or worker has to stay open. |
| PM-2  | An accessible PR created outside Farmslot by another author can be added by URL with notify-only policy, no run and no project. Duplicate adds preserve one monitor; equal PR numbers in different repositories do not collide.                                               |
| PM-3  | Notify-only persists and delivers an attention item without enqueuing a run or acquiring a slot. Repeated polls, a gateway restart, and two connected clients do not duplicate that incident notification.                                                                    |
| PM-4  | Automatic repair for an eligible mapped PR creates one normal `pr-complete` queue entry and a linked run. Concurrent poll/webhook observations and a crash/restart during admission still yield at most one execution owner.                                                  |
| PM-5  | A later base-branch change that creates a conflict is detected without a new PR-head commit. A readable but unwritable external/fork branch reports why automatic repair is unavailable and receives no write or substitute PR.                                               |
| PM-6  | A repair's own push and an unchanged old review do not cause an infinite repair loop. Edited feedback or a new check attempt can create new actionable evidence. Attempt limits surface a decision instead of repeatedly dispatching the same failed repair.                  |
| PM-7  | Existing `ci-watch` or manual repair ownership prevents duplicate automatic work. Incident changes observed during repair are retained, then evaluated against fresh GitHub state after the run ends.                                                                         |
| PM-8  | With all slots busy or host-pressure admission blocked, the repair remains queued with an explanation and monitoring holds no slot. A policy downgrade or PR closure before dispatch prevents the queued job from starting.                                                   |
| PM-9  | Both clients show the same reason, timestamps, policy, incident and linked repair. An action from one client or CLI updates the other client without a page reload; a backgrounded Companion can open a push into the current incident state.                                 |
| PM-10 | Lost credentials, provider errors and exhausted quota expose stale/access-lost state with retry timing. Recovery does not fabricate new progress, replay acknowledged history, or authorize repairs from stale observations.                                                  |
| PM-11 | An issue fixed externally clears or supersedes the matching incident after a fresh read. Worker completion alone does not clear still-failing checks. A dependency-blocked repair remains visible with no repeated identical dispatch.                                        |
| PM-12 | Merge/close stops monitoring and retains audit history; an explicit resume handles a reopened PR. Pausing/stopping a watch preserves already-running work and the PR itself.                                                                                                  |

#### Delivery outline and existing foundations

Implementation is authorized and tracked in the [execution plan](plans/persistent-pr-monitoring.md). [ADR-055](adr/055-persistent-pr-monitoring-and-review-intake.md) records the proposed architecture; completed validation will establish its implemented status.

1. Gateway/protocol monitor identity, persistence, lifecycle, observation health and notify-only incidents. Prove explicit external-PR enrollment, late review detection, restart catch-up and repo-scoped identity.
2. Command Center and Companion watch queue, shared incident actions and push deep links. Prove cross-client updates through the production gateway and normal UI interactions.
3. Automatic repair admission, existing-run ownership coordination, deduplication and limits. Prove separate-client duplicate requests and crash recovery through real queue/run endpoints.
4. Opt-in enrollment from successful publication, policy controls, quota-aware polling and operational diagnostics. Prove that releasing a slot or closing clients leaves the monitor active.

Existing code to reuse or adapt, not declarations that this feature is shipped:

- [PR status and dashboard discovery](../services/gateway/src/methods/pr.ts): current discovery depends on slots/runs and has a seven-day terminal-run window; `pr.status` currently requires project context. Explicit subscriptions need independent identity and read-only repository/account binding.
- [PR raw cache](../services/gateway/src/methods/pr/raw-cache.ts) and [GitHub request budgets](../services/gateway/src/integrations/github-client.ts), with [ADR-028](adr/028-pr-dashboard-github-quota.md), supply polling reuse and quota controls.
- [CI monitoring](../services/gateway/src/ci-monitor/service.ts) and [dedup state](../services/gateway/src/ci-monitor/state.ts) supply existing observation/fix concepts. Their run lifetime must not become the subscription lifetime.
- [Dispatch queue](../services/gateway/src/backlog/dispatch-queue.ts), [run contracts](../packages/protocol/src/contracts/runs.ts), and [decision projection](../services/gateway/src/run-engine/decision-projection.ts) are the shared execution and client-inbox integration points.
- [Principal and credential model](adr/051-principal-and-credential-model.md) and [run lifecycle routing](adr/053-run-lifecycle-transition-routing.md) remain the authority for permissions and cross-store transitions. The watch service should not invent a parallel dispatcher or notification-only state silo.

### 7. Declarative trigger rules and review intake (planned)

**Status:** proposed product contract, captured 2026-09-09. Rules generalize event-to-work intake; GitHub repositories and GitHub Projects are the first source adapters. They complement persistent PR monitoring rather than replacing it.

#### Outcome and concepts

An operator can define which team PRs deserve attention across multiple repositories or GitHub Projects, then automatically collect matching PRs into a review queue. The PR author need not be the operator or a Farmslot worker. Labels, team membership and Project fields are configuration, not product-specific branches in Farmslot code.

A **trigger rule** combines sources, matching predicates, event/revision policy, and actions. A **rule match** records why a particular source revision matched. A **review intent** is held or queued `review-pr` work linked to that match. The review queue is a client view over persisted review intents/backlog items and existing dispatch entries, not a new worker dispatcher.

Rules discover subjects and request actions. Monitors keep observing selected PRs after runs finish. A rule may add a PR monitor, enqueue a review, or create a notification; a monitor's policy can later enqueue `pr-complete` when changes are needed. Starting a review is distinct from modifying a PR to repair it.

#### Shared team scope and review policy

A reusable team profile defines the PR scope consumed by trigger rules and monitored-PR views. It must work for one person or several teams without relying on personal workspace files, a fixed GitHub username, or a particular organization's conventions. A profile records:

- Repository and GitHub Project sources, team labels or field bindings, and optional explicit participant identities. PR eligibility may include other authors; team ownership, authorship and execution authority are separate facts.
- Review policy overrides by repository, exclusions such as a configured parked-work label, and configurable inactivity thresholds. No personal approval count, label name or stale-age threshold becomes a framework default.
- Notification audience and authorized action owners. Membership in the audience does not grant repository access or permission to launch repairs.

Rules reference a versioned profile and explain its contribution to each match. Profile edits preview eligibility changes and use the same future-change/backfill and pre-dispatch checks as rule edits. A profile cannot silently enable Farmslot publication enrollment for its projects or upgrade monitor repair policy.

Two teams may track the same PR. Preserve both teams' match provenance and authorized notification audiences while retaining one canonical PR and shared execution ownership. A team can remove its interest without removing another team's watch. Shared observations and deduplication must respect credential/access boundaries; clients cannot see another team's private facts or policy controls merely because the PR identity matches.

Review facts retain their source, observation time and relevant head SHA. GitHub review decisions and required checks determine provider requirements; configured approval counts are supplemental. Project workflow Status, review requests and inferred CODEOWNERS candidates remain separate. An inferred owner is not proof that GitHub requires or is waiting for their review. A commit pushed after a changes-requested review can indicate that re-review may be needed; it does not prove the feedback was fixed or dismiss the review. Conflicts and failing or unknown required checks prevent a ready-to-merge claim even when review requirements are satisfied. Readiness never authorizes merging.

The same scope and facts can later support personal or team activity summaries covering authored, merged, reviewed and commented PRs. Broader organization discovery must be explicitly scoped per activity type; a reporting scope cannot silently enroll more PRs into monitoring or review. Timezone, reporting windows, display order, destination identity mappings and optional issue-tracker inputs belong to that later summary configuration. Scheduled digests, Jira integration and message posting are outside V1. Summaries must preserve missing-data states and cannot invent planned work or infer "no blockers" from an empty query.

#### Source and matcher contract

- Support explicit sets of repositories, GitHub Project memberships, or both, across more than one Farmslot project. Normalize a PR into the same canonical host/repository/PR identity used by monitoring. Multiple source memberships do not create multiple PR identities.
- A GitHub Projects adapter resolves PR-backed items and configured field values. Issue-only items and draft notes are ignored with a visible explanation in V1; they are not guessed to be PRs. Read-project permission is separate from repository-read permission, and unavailable fields are reported as unavailable rather than silently treated as non-matches.
- Selecting a GitHub Project restricts candidates to that Project's items; selecting repositories scans those repositories. View import must preserve Project membership rather than silently widening the source to every PR with the same labels.
- A Project/view URL can start source setup. Resolve its Project and display the configured filters. Saved-view filter import may support a documented subset; unsupported terms must be surfaced and mapped explicitly before enabling, never dropped to widen the matching set.
- Bind Project fields/options by provider IDs and typed values, with display names for the operator. A field rename preserves the binding; deletion or incompatible type changes disable affected evaluation with a repairable configuration error. A Project Status field is a team-managed workflow value, not GitHub reviewDecision, mergeability, CI status, or a Farmslot run status; expose each separately.
- V1 predicates include repository, Project membership, labels, PR author, explicitly configured GitHub team membership, open/closed and draft/ready state, branch patterns, changed-path globs, and mapped Project fields. A team can be selected through a field, a label convention, or provider membership; these meanings are explicit and not interchangeable. Missing permission or incomplete pagination yields Unknown, not a false fact.
- Predicates use a bounded declarative all/any/not expression with typed operators. Do not execute arbitrary shell, JavaScript, prompts, or source-controlled instructions as rule conditions or actions. A provider adapter supplies facts; PR content cannot change the rule's authority.
- Evaluate provider events and scheduled reconciliation through the same rule path. Changes to labels, draft status, Project membership/fields, and PR heads must be observable without requiring a new PR-open event. Pagination and scan cursors persist so large Projects are processed completely under a bounded request budget.

Illustrative configuration, not a hardcoded team workflow:

| Part               | Example                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Sources            | PR-backed items from two configured GitHub Projects spanning application and library repositories                              |
| Match              | PR is open, is not a draft, has the configured team label, and its mapped Project Status is in the configured needs-review set |
| Repository mapping | Each repository resolves to its configured Farmslot project and review profile                                                 |
| Action             | Add a held `review-pr` item to the shared review queue                                                                         |
| Optional action    | Add the same PR to persistent monitoring with notify-only policy                                                               |

A team review board can be expressed as a reusable rule preset: an explicit repository set, PR-only subjects, a configurable `team-*` label, and drafts excluded. Grouping the queue by repository is presentation only. Project Status options can then map to separate intents:

| Configured Project Status category | Example response                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Needs development review           | Enqueue `review-pr` according to the rule's held/auto-start policy                                                                                           |
| Needs work from the author         | Create attention or request repair only when automatic repair was explicitly authorized; do not keep launching reviews while the team is waiting for changes |
| Review finalized / ready for merge | Continue monitoring CI and mergeability; do not infer merge authorization or a passing check suite from the Project field                                    |

These categories and option names are bindings chosen by the operator, not reserved Farmslot enum values. A source view without an explicit open-PR filter still cannot cause work on a closed or merged PR: admission checks authoritative GitHub state. Rule-driven Project field updates are outside V1; importing a board does not grant writeback authority over the team's workflow.

#### Actions and execution policy

V1 actions are Notify, Add PR monitor, and Enqueue review. Each action has an explicit execution policy and owner. Rule configuration records enabled state, source credential references, target-project mapping, review profile, priority and limits. Creation starts disabled; enabling shows a dry-run preview of matches, missing mappings, expected queue entries and effective authority.

**Automatic enqueue does not imply automatic execution.** The default review action creates a held review intent for operator acceptance. An explicitly enabled auto-start option can admit it into the normal dispatch queue without a second approval prompt. Standard slot/host-pressure limits and project review/posting policies still apply. A rule never grants automatic merge or permission to bypass a publication/review gate.

A rule may cover multiple repositories but each executable match must resolve to an authorized project and workflow profile. Missing mappings produce Needs configuration, visible in the review queue; no arbitrary slot is chosen and no repository registration is silently fabricated. Read-only monitoring or notifications can still work for an unmapped repository. Running a review of an external PR does not grant permission to push to its author's branch or post an approval.

Adding a monitor is idempotent. A rule does not upgrade an existing notify-only monitor to automatic repair merely because another rule matched it. Changing that monitor's policy remains an explicit authorized action.

Activation and edits apply to future matching changes by default. An explicit previewed backfill can enqueue currently matching PRs. Proposed review granularity is once per eligible PR head and review profile, with configured head-change re-review behavior. Cosmetic edits to a rule do not re-review every historical match.

#### Review slots and models

Each review action selects an execution profile, with reusable team defaults and explicit per-rule or repository overrides. Operators can pin one slot or allow a list of slots, and select the runner, model and supported reasoning effort. The editor shows the effective configuration after inheritance. These are dispatch constraints, not hints that the scheduler can ignore.

- A single slot pins execution to that slot. A list allows the existing scheduler to choose one available, authorized slot compatible with the target project and review's required capabilities. It does not launch a review on every listed slot or reserve idle slots between reviews.
- Model choices are explicit runner/model/effort combinations, validated through the shared runner capability contract. One choice pins the model; an optional ordered list authorizes alternatives, with per-slot bindings when slots support different runners. The scheduler selects only an allowed slot/model combination and records the selection reason. Multiple alternatives do not request multiple independent reviews.
- Busy or temporarily offline eligible slots leave the review queued with a reason. Deleted slots, incompatible project mappings or unsupported model/effort choices produce Needs configuration when no valid combination remains. Never fall back to an unlisted slot, runner, model or effort. Host-pressure and capacity limits still apply.

Preview shows eligible slot/model combinations and configuration errors before activation. Queue items in both clients show requested slots, models and effort, then the actual assignment when dispatched. Revalidate the current execution profile before claiming a slot, including after restart or a profile edit. Profile edits affect unstarted work; running reviews retain their recorded assignment. Changing a slot or model setting does not by itself rerun a completed review.

Deduplication retains execution constraints from every contributing rule. A shared intent can start only with a combination allowed by all contributors; incompatible requirements remain held with an explanation until an authorized operator resolves them. Deliberately separate reviews use distinct review profiles and the existing per-PR execution coordination. Repair policy remains independently configured; selecting a review model does not change a monitor's repair model or authorize repair.

#### Reviewer continuity

Review policy includes the existing Continue/Fresh session choice and static/full-live validation depth. Default follow-up rounds to Continue for the same PR and review profile. Retain the selected reviewer identity, native session reference, reviewed SHA and findings so an incremental follow-up supplies the new diff and unresolved findings to that reviewer. Initial rounds start fresh. A requested full independent review starts fresh under the existing review-scope contract.

Reuse the existing repeat-review chain and runner session adapters. Session reuse requires a compatible runner/model, slot, principal and PR context. If the session cannot resume, record the reason and show the fresh fallback in both clients. Do not claim a resumed session from pane text. Warm context does not reserve a slot between rounds, bypass execution ownership or carry a previous verdict forward to a new SHA. Team/repository defaults and per-rule/request overrides expose the same controls as manual reviews.

A selected pool of slots can rotate among PRs. Completing a round releases its slot while retaining that PR's reviewer session reference and last reviewed SHA. Later changes queue a new round that reloads the compatible saved session, even after the slot reviewed other PRs. Continue prefers the prior compatible slot and waits if it is busy; an explicit available-slot policy permits a fresh fallback elsewhere. No session context is shared across PRs. The live proof must cover A, then B on the reused slot, then A again with the original session and the A-head delta.

#### External intake clients

Command Center, Companion and external integrations must be able to submit an individual PR for review or review plus live QA under a configured team/project policy. Human submissions and discovery rules produce the same durable review intent, with shared deduplication, slot/model constraints, authorization, status and evidence. Submission provenance and requester references are audit data; an external username does not confer execution authority.

Submission returns a durable receipt before provider reads complete. The same owner/idempotency key always identifies the same immutable request. Pending requests for the same PR/head/profile share an intent. An explicit new request after execution starts creates a follow-up round, so a completed static review cannot satisfy a newly requested live QA or Fresh review. Follow-up rounds use the same review chain and PR ownership controls.

Slack-specific behavior belongs in an optional external app or integration package. That app handles workspace/channel membership, commands or mentions, forms and thread updates through the core API. Farmslot needs no Slack SDK or Slack configuration to run. The adapter's implementation and installation remain separately scoped; a new plugin-host framework is not a prerequisite.

#### Admission, lifecycle and explainability

- Deduplicate provider deliveries, repeated scans, gateway restarts, overlapping Projects, and overlapping rules that request the same PR/head/review profile. Keep all matching-rule provenance on the one intent. Distinct review profiles may request distinct reviews; duplicating a rule name or ID is not a new review purpose.
- Record rule version, normalized facts and source revision, match explanation, effective policy, idempotency key, admission result, and resulting queue/run IDs. The durable admission path must recover from a crash without dropping the intent or launching a duplicate.
- Before execution, re-read PR state/head and eligibility, re-check rule enablement and current authority, and resolve the current project mapping. For the default latest-head review policy, replace a stale queued target with the latest eligible head instead of starting obsolete work. A completed review is always associated with the SHA actually reviewed.
- Disabling a rule, removing a PR from its matching set, or making it draft/closed withdraws its unstarted action unless another enabled matching rule still authorizes that same intent. Existing review results and audit records remain. Active runs continue under their own lifecycle controls; cancellation is explicit.
- Use shared per-PR execution ownership with monitors, existing CI-watch, manual work, and repair runs. A review must not be presented as reviewing the latest branch while another worker is mutating it. Newly required review work can wait for the active repair and then bind to the resulting head.
- Apply per-rule admission limits, cooldowns and the gateway's global request/dispatch budgets. Label/field churn, webhook retries, and rule-generated labels/comments must not create self-triggering loops. Exhausted limits produce an attention item with the reason and next eligible action/time.
- Command Center provides source selection, typed rule editing, dry-run preview, explicit backfill, enable/disable, match history and the review queue. Each queue item explains which rules and facts matched, who owns the action, whether it is held or auto-starting, and why it cannot start.
- Companion shows the same rules' status, actionable review intake, match reasons, queued/running work, and notifications. It supports accepting/deferring an item and enabling/disabling an authorized rule. Complex predicate/field mapping authoring can remain in Command Center/CLI in V1. All actions use shared gateway APIs and broadcast authoritative updates.

#### Acceptance criteria and integration

| ID    | Acceptance criterion                                                                                                                                                                                                                                                                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TR-1  | A configured GitHub Project rule matches PRs across at least two repositories by mapped team criteria and queues reviews for PRs authored by other users. No team, organization, repository or Project number is hardcoded in framework logic.                                                                                                                              |
| TR-2  | Adding a label, setting a Project field, entering a Project, or changing a draft to ready can produce the same normalized match as a PR-open event. Unsupported view filters and unavailable fields are shown before activation.                                                                                                                                            |
| TR-3  | Repeated events, restart, two matching rules and membership in two Projects produce one intent for the same PR/head/review profile, with every source/rule retained in its provenance.                                                                                                                                                                                      |
| TR-4  | Dry run causes no subscriptions, queue writes, notifications or worker launches. Activation does not process historical matches unless explicit backfill was selected.                                                                                                                                                                                                      |
| TR-5  | Queue-only policy creates visible held review work and occupies no slot. Auto-start admits eligible work through the normal dispatch queue and respects capacity, pressure, credentials and project review policies.                                                                                                                                                        |
| TR-6  | An unmapped or unauthorized repository reports Needs configuration; loss of source access reports Unknown/stale coverage. Neither condition creates a worker or assumes the PR author supplied authorization.                                                                                                                                                               |
| TR-7  | A queued PR that changes head is rebound or superseded before execution; a disabled rule or no-longer-eligible PR cannot start from an old queue entry. Review completion records the actual reviewed SHA.                                                                                                                                                                  |
| TR-8  | Command Center and Companion show the same matched reason, hold/queue/run state and required action. Accepting or disabling from one client updates the other without reload.                                                                                                                                                                                               |
| TR-9  | A rule that adds monitoring preserves an existing monitor's policy. Monitoring/CI repair and rule-triggered reviews coordinate execution ownership instead of launching competing work on the same PR.                                                                                                                                                                      |
| TR-10 | Project Status routing distinguishes needs-review, waiting-for-author and ready-for-merge categories without equating them to GitHub review/CI status. Changing a configured Status can admit or withdraw unstarted review work; a ready-for-merge label never merges a PR.                                                                                                 |
| TR-11 | Two team profiles with different repository policies and exclusions drive their own previews and filtered queues without hardcoded personal configuration. Editing a shared profile revalidates unstarted work and never silently enables project publication enrollment.                                                                                                   |
| TR-12 | Two teams matching the same PR/head/review profile share one review intent while preserving authorized audiences and provenance. Removing one team's interest preserves the other's watch; neither team gains access or execution authority from deduplication.                                                                                                             |
| TR-13 | A PR with enough numeric approvals but an outstanding GitHub review requirement, conflict, or failing/unknown required check is not presented as ready to merge. A newer commit does not clear an active changes-requested review; inferred owners are labelled separately from provider requirements.                                                                      |
| TR-14 | A rule pinned to one slot and runner/model/effort starts only on that combination. A rule allowing several slots or model alternatives selects one compatible combination and records it. Busy/offline slots leave work queued without acquiring another slot or launching duplicate reviews.                                                                               |
| TR-15 | Unsupported effort/model choices and missing compatible slots appear in preview and queue explanations. Restart and execution-profile edits revalidate unstarted work; running assignments remain recorded and completed reviews do not rerun merely because settings changed.                                                                                              |
| TR-16 | Overlapping rules with incompatible slot/model constraints produce one held intent with a configuration conflict, not an unauthorized fallback. Both clients show requested and actual assignments, effective profile and the reason work is waiting.                                                                                                                       |
| TR-17 | Follow-up review rounds honor configurable Continue/Fresh and static/full-live choices. Continue resumes the compatible native reviewer session with prior findings and the changed diff; unavailable sessions show an explicit fresh fallback. Restart preserves the review chain, no slot is reserved between rounds, and each verdict records the SHA actually reviewed. |
| TR-18 | Direct review/QA submissions return durable idempotent receipts, share pending intake with rules, and create explicit follow-up rounds after execution starts. Provider failure cannot authorize work; cancellation withdraws unstarted requests, and the same receipt remains readable after reconnect or policy edits.                                                    |

Use the existing [webhook adapter](../services/gateway/src/webhook.ts), [dispatch queue](../services/gateway/src/backlog/dispatch-queue.ts), [backlog contracts](../packages/protocol/src/contracts/backlog.ts), GitHub request budget layer, and principal/credential model. The current webhook handler handles a small set of PR events for a repository-matched project and directly queues `review-pr`; it is not a general rules engine. Route rule-enabled source events through the new matching/admission path so the old webhook path cannot dispatch the same review a second time. Preserve explicitly configured legacy behavior until migrated; do not silently enable new rules from it.

Implement source/fact binding and side-effect-free previews first, then durable manual review intake, then authorized auto-start and monitor enrollment. Prove replay/restart/dedup behavior through real gateway queue/run endpoints, plus normal UI actions in both clients. Jira and other providers can later supply the same normalized subject/fact contract, but additional source adapters are outside V1.

## Boundaries

This chunk does **not** own:

- the shared slot lifecycle primitives themselves (Core Farmslot)
- the desktop UI contract (Command Center)
- the native mobile UI contract (Mobile Companion)
- the runner-neutral execution contract, except where automation consumes it

## Supporting Evidence and Deep Dives

- [ROADMAP.md](ROADMAP.md)
- [ROADMAP-next.md](ROADMAP-next.md)
- [reference/](reference/)
- ADR-013, ADR-014, ADR-016, ADR-017, ADR-021, ADR-024, ADR-025, ADR-026, ADR-027, ADR-029
- The bugfix local-first publication gate PRD/test spec and PR #73 for the shipped publication boundary
- The eval-package template-regression roadmap for the active artifact-only eval-package slice

## Success Condition for This Chunk

Farmslot can orchestrate, observe, review, and improve autonomous work through persistent supervised workflows that remain explainable and recoverable across sessions and surfaces.
