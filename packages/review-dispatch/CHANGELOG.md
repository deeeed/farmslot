# Changelog

## Unreleased

- Share fleet workspace rows, safe bulk release, discard confirmation and recovery progress between both operator apps.

- Share plain CI-watch check counts, failing names, next poll and timeout countdown between both clients.

- Show completed checklist durations and live current-step elapsed time in both operator apps.

- Share publication blocking while a review refresh is pending or failed.

- Share current-checklist counts, item labels and attempt identity for run progress in both clients.

- Show original and derived acceptance, source links, inherited proof, pending instructions and exclusions consistently in both clients.

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.19.0 - 2026-10-25

- Show original and derived acceptance, source links, inherited proof, pending instructions and exclusions consistently in both clients.

## 0.18.1 - 2026-10-24

- Count activity review rounds in the owning budget, excluding other maintenance runs and refunded attempts while retaining legacy gate fallback.

## 0.18.0 - 2026-10-23

- Add shared CI-watch card summary and countdown presentation.

## 0.17.0 - 2026-10-23

- Share completed checklist durations and live current-step elapsed time between both operator clients.

## 0.16.0 - 2026-10-23

- Share publication blocking during pending or failed review refreshes.

## 0.15.0 - 2026-10-23

- Show combined findings acceptance and evidence attestation with both scopes and one written reason in the shared publication gate.

## 0.14.0 - 2026-10-22

- Add shared current-checklist progress for run lists and detail.

## 0.13.0 - 2026-10-22

- Share native conversation targets, review and fix timelines, frozen finding locations, recovered review failures and gate refresh readback across both operator apps.

## 0.12.0 - 2026-10-22

- Share review history derivation and artifact loading across Command Center and Companion, including active rounds before a publication gate.

## 0.11.1 - 2026-10-22

- A passing review continuation settles its own earlier findings after evidence-only fixes, without requiring another review or changing the retained history.

## 0.11.0 - 2026-10-21

- Share run terminal actor selection and target identity between Command Center and Companion, including finished-run availability.

## 0.10.1 - 2026-10-21

- Publication blockers carry finding summaries and inline actions. WARM review choices inherit and lock the retained runner, model and effort, and refuse unavailable sessions.
- Publication blockers exclude evidence findings settled by a qualified person claim confirmation, while retaining code findings and the original review provenance.

## 0.10.0 - 2026-10-21

- Share the current run activity, worker/reviewer node, review round, attempt start time and visible step states between Command Center and Companion; ordinary review flows keep their actual review step as the running node.
- `publicationGateBlockers` lists what blocks publish at a gate that is not ready, one plain action each: `Skip this criterion…` for a criterion with a missing, weak or failed verdict, `Accept findings and publish…` for open review findings, `Give it another round` for spent review rounds; other readiness reasons are listed as worded. `untestableOverrideView` (the untestable override, now worded as skipping the criterion; the protocol action stays `mark-untestable`), `anotherReviewRoundView` and `anotherReviewRoundParams` (an idempotent `run.extendReviewBudget` request) give both clients the same copy and rules.

## 0.9.1 - 2026-10-21

- Gate requests keep a validated lineage in WARM when its session is unavailable, with its earlier model and effort, and explain that a fresh session will review only the changes.

## 0.9.0 - 2026-10-21

- Align with `@farmslot/protocol` 0.61.0, `@farmslot/adapter-sdk` 0.25.1.
- A lineage recorded before a PR is valid and names its run family; one recorded with a PR keeps its repository/PR (`reviewLineageKey`). The gate picker's `lineageOptions` preselect each row runner's most recent available lineage in WARM with its model and effort, once per lineage, and a row whose earlier lineage can't continue stays COLD with a `note` saying why; a person's COLD at the gate stays in its lineage, and a runner change reallocates lineages so no two rows share one (ADR-063 Amendment 5). `reviewLineagesForRun` also reads a gate row's attempts, so a row whose request was refused keeps its lineage. `gateReviewLineageOptions` reads those lineages from a ready gate, and `reviewFallbackLine` words why a review ran a delta-scoped COLD and the ranges it compared.
- `publicationGateView` offers accepting the open review findings (`acceptFindings`, with `findings`) while they block every other publish approval, and asks for the reason when `acceptingFindings` is set. `reviewFixInProgress(run)` and `reviewFindingEntries(reviews)`, the review entries the publication block counts, are exported.

## 0.8.0 - 2026-10-20

- `humanGateBlockingReason(run)` words a run's blocking review findings by its open human gate's actionable reason; with no findings it is empty. `publicationGateView` takes an optional `gate` and shows that reason as its status. The publish guard still uses `publicationReviewBlockingReason`.

## 0.7.0 - 2026-10-19

- Align with `@farmslot/protocol` 0.59.0 and `@farmslot/adapter-sdk` 0.24.0.

## 0.6.0 - 2026-10-19

- Align with `@farmslot/protocol` 0.58.0 and `@farmslot/adapter-sdk` 0.23.0.

## 0.5.0 - 2026-10-19

- Align with `@farmslot/adapter-sdk` 0.22.0.

## 0.4.0 - 2026-10-19

- `acceptanceClaimRows` reads a `review` claim (ADR-062 Amendment 18) as "Checked in review" when proven and "Awaiting code review" otherwise, never `missing`.
- Align with `@farmslot/protocol` 0.57.0 and `@farmslot/adapter-sdk` 0.21.0.

## 0.3.0 - 2026-10-19

- The needs-decision view model that Command Center and Companion share (ADR-065 Amendment 7): `resultDecisionView`, `pendingResultDecision`, `isResultDecision`, `evidenceOnlyDecisionIds` and `resultDecisionActionReady`. Refused prerequisites are titled by count. `runResultsSummary` says a held run waits for a decision and an accepted one was accepted, with its reason.
- `acceptancePanelPresentation` returns `defaultOpen` in place of `hasOpenCriteria`. While no criterion is assessed, the panel shows only its counts line and the criteria list opens on demand.
- Align with `@farmslot/protocol` 0.56.0 and `@farmslot/adapter-sdk` 0.20.0.

## 0.2.5 - 2026-10-18

- Align with `@farmslot/adapter-sdk` 0.18.5.

## 0.2.4 - 2026-10-18

- Align with `@farmslot/adapter-sdk` 0.18.4.

## 0.2.3 - 2026-10-18

- Align with `@farmslot/adapter-sdk` 0.18.3.

## 0.2.2 - 2026-10-18

- Align with `@farmslot/protocol` 0.55.0 and `@farmslot/adapter-sdk` 0.18.2.

## 0.2.1 - 2026-10-17

- Share the run results card summary, the acceptance tally, report link resolution, the web-link check and the artifact HTML policy, so Command Center and Companion show the same results for a run's retained output and open the same artifact from a report link. A review-workspace run shows no results card.
- Align with `@farmslot/adapter-sdk` 0.18.1 and `@farmslot/recipe-runner` 0.39.1 (network capture summaries redact credential-like path segments).

## 0.2.0 - 2026-10-17

- Make Send back to agent the gate's one primary action when offered, with recovery status and earlier-proof row details.
- Withhold publication approval while review findings or a fix remain unresolved, and show the shared review status until the fixed head passes review.
- Share the gateway no-code-review warning without disabling publication approval.
- Share declared gate criteria across client loading layouts.
- Share publication decision status, AC judgment rows and attestation availability across operator clients.
- Use gateway device-session expiry in clients instead of the temporary local sign-in lifetime.
- Document modelPickerState as the renderer API and remove the unused modelChoices method.
- Share model filtering and custom-model detection between the web and native execution pickers.
- Share compact checklist-progress presentation across operator views.
- Share client sign-in expiry and sign-out confirmation across operator apps.
- Resolve review mode once across explicit selections, recorded run/PR options and project defaults.
- Keep project review policy fields out of review selections while preserving configured defaults.
- Add shared review and dispatch selection state, capability defaults, strict validators and ordered request serialization for web, mobile, CLI and gateway consumers, preserving 20-row PR execution profiles and explicit saved defaults.
- Share AC row state and judgment controls across publication, preview and evidence views in both clients, with qualified pipeline verification for every visual AC.

## 0.1.1 - 2026-10-16

- Consume the recipe-runner 0.38.1 still-filename fix throughout the worker dependency set.
