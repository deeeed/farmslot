# Persistent PR monitoring implementation

**Status:** Implemented; integration validation and PR review in progress.
**Owner:** Farmslot automation. Keep this plan until implementation and evidence are complete, then fold durable details into references and implemented history.
**Authority:** [Product contract](../PRD-automation-intelligence-canonical.md#6-persistent-pr-monitoring-planned), [roadmap items 19 and 20](../ROADMAP-next.md), [ADR-055](../adr/055-persistent-pr-monitoring-and-review-intake.md).

## Objective

Deliver persistent PR monitoring and team review rules through the gateway, Command Center and Companion. Include external PRs, per-project opt-in publication enrollment, notify-only/automatic repair, Project/repository discovery, reusable team scope, and explicit slot/runner/model/effort selection.

## Execution and evidence

| Slice | Work                                                                                                  | Required verification                                                                                                     | State       |
| ----- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1     | Protocol, canonical PR identity, durable records, versioned policies and authority                    | Invalid inputs, repository collisions, independent subscription interests, persistence/restart and access-boundary checks | In progress |
| 2     | GitHub observations, incidents, scheduler, monitor RPC and opt-in publication enrollment              | PM-1, PM-2, PM-3, PM-5, PM-10, PM-11, PM-12 through gateway reads/mutations; preserve originating run completion          | In progress |
| 3     | Team profiles, typed predicates, paginated Project/repository sources, preview and held review intake | TR-1 through TR-4, TR-6, TR-10 through TR-13; preview has no side effects and unavailable facts stay unknown              | In progress |
| 4     | Shared queue admission, review slot/model policies, repair dispatch and PR ownership                  | PM-4, PM-6 through PM-8; TR-5, TR-7, TR-9, TR-14 through TR-16; crash/restart and policy revocation at run creation       | In progress |
| 5     | Command Center controls and Companion queue/actions/push                                              | PM-9, TR-8 and assignment visibility through actual client interactions; cross-client broadcasts and reconnect            | In progress |
| 6     | Integrated recipes, failure injection, documentation and review                                       | All ACs mapped to evidence; targeted tests and required quality checks; independent and cross-model review; fix findings  | In progress |

Each slice extends a committed recipe or validation scenario for its real gateway/client behavior. Unit tests protect domain logic but cannot substitute for live proof. Validate failure detection by making the relevant assertion fail, restoring the implementation, and rerunning it. Keep generated logs and private provider evidence outside public docs.

## Constraints

- Existing dispatch queue and lifecycle router remain the execution owners. No dummy runs or idle slot reservations for monitoring.
- Team labels, repositories, fields and approval policies are configuration. Publication monitoring stays opt-in per project.
- Source access, notification audience and execution authority remain separate. Recheck current authority for deferred starts.
- No automatic merge, scheduled standup posting or package-release automation.
- Existing ADR history stays intact. ADR-055 records the new decisions and remains proposed until validated.
- Keep external chat integrations optional. Core owns provider-neutral PR review/QA intake; a separate Slack app or plugin owns channel commands, membership checks and replies. Slack implementation is outside this goal.

## Remaining integration coverage

The full PM/TR live acceptance matrix remains incomplete. Outstanding scenarios include provider-backed Project webhook delivery, notification deduplication across two background clients, and a live repair after the draft-preservation guard. Keep these limits explicit when assessing release readiness. Private run histories and account-specific evidence are stored outside this repository.
