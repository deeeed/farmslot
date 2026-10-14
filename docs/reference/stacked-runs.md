# Stacked runs

Normative reference for the accepted [ADR-040 stacked-runs decision](../adr/040-work-graph-orchestration.md#amendment-stacked-runs-2026-10-07). The gateway owns stack binding, contribution lineage, publication bases and graph retargeting. This specification describes existing contracts; retained-run attachment is a separate proposal.

## Admission and prepare

A same-project `published` graph edge identifies one upstream base. The downstream node waits for the upstream family's published PR and pushed branch. Setting `upstreamBaseNodeIds` alone does not enable stacking.

Before writing a dev or fix-bug task, `ensureRunStack` verifies the upstream PR. An open same-repository PR supplies `run.stack.baseBranch`. A merged PR produces an ordinary default-branch run; a closed unmerged or fork PR refuses preparation. Prepare fetches the upstream branch, creates the work branch from its head and records `resolvedSha` before later phases.

## Bases and maintenance

| Purpose                                                  | Authoritative reference                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| PR target, package, preview and review                   | `publicationBaseForRun` over contribution lineage                 |
| Worker rebase for pr-complete, update-branch and ci-fix  | The same resolved `PUBLICATION_BASE`                              |
| Default-branch freshness and zero-ahead close-as-shipped | Configured project default, falling back to `DEFAULT_BRANCH`      |
| Contribution ownership                                   | Recorded stack point and the existing contribution-diff algorithm |

`contributionStack` follows the run's existing family lineage, including archived ancestors. Publication uses `retargetedTo` when present, otherwise the upstream `baseBranch`. An ordinary run uses the configured default. Follow-up flows must consume this resolver and must not infer a stack from a PR body or task badge.

A rebase fetches the resolved publication branch and the PR head, records the exact remote PR-head SHA, and refuses to discard commits present only on origin. After conflict resolution and required validation, its push uses an explicit lease against that recorded SHA. A failed fetch remains unknown, never a clean freshness result. Rebasing onto the publication branch does not waive default-branch freshness requirements.

Contribution diffs exclude upstream and unrelated default-branch work. The existing algorithm preserves the recorded branch point, synthesizes the appropriate merged base when needed and attributes conflict resolutions to the child. Once HEAD contains the recorded upstream merge, or has rebased off the stack, ordinary contribution comparison applies.

## Retarget and recovery

A `merged` completion edge with `rebase-onto` retargets the child PR to the default branch and records `run.stack.retargetedTo` and the upstream merge SHA. Pending publication uses that target too. The existing graph maintenance waits until the family is idle before GitHub's update-branch catch-up; that automatic merge mechanism remains distinct from worker rebases. Conflicts remain for the supported update-branch flow.

Ci-watch records merges. An operator-targeted graph tick can discover a quiet upstream merge and finish its follow-on actions in the same tick. Failures are retained in the graph ledger and retried with a targeted tick. Archiving an open stacked run removes it from automatic maintenance. Each link in a longer chain uses its own published upstream and retarget state.

## Public surface

- Existing CLI: `farmslot graph add-edge` with `--condition published`; a merged completion edge uses `--blocks completion --unlock rebase-onto`. `farmslot graph tick <graphId>` retries maintenance. See [operator steps](../operations/stacked-work.md).
- Gateway owner: internal `publicationBaseForRun` and `contributionStack`; no new RPC, store or SDK stack resolver. Existing `Run.stack` and graph records retain their formats.
- Task consumers: the gateway supplies `PUBLICATION_BASE` to branch-maintenance tasks and CI-fix checklists. `@farmslot/agent-runtime` exports `buildBranchUpdateInstructions` for the task builder and gateway's inline CI-fix writer. Inline fixes receive current instructions independently of the retained TASK.md. Standalone callers must supply a resolved base when selecting a template that requires it.
- Versioning: deploy the supplying gateway/task runtime before migrating pack templates or passing the value to existing rebase helpers. Public template variables are documented in the [generated catalog](template-variables.md); no new CLI flags are introduced.

## Proposed maintenance checkpoint contract

Status: Proposed under [ADR-040 Amendment 4](../adr/040-work-graph-orchestration.md#amendment-4-verified-branch-maintenance-checkpoints-2026-10-14). This section is not a claim of deployed behavior.

### Authority and operation input

The publishing ancestor is resolved through existing contribution lineage. A stacked family's maintenance authority is its last verified `engineState.publishGate.maintainedSnapshot`, falling back to the frozen publication `reviewSnapshot` for the initial operation. Both use `ReviewDiffSnapshot`: `baseRef` names the resolved publication branch, `baseSha` is the verified parent boundary, and `headSha` is the verified child head. Unavailable or incomplete authority MUST refuse; task prose, PR bodies and mutable diff artifacts MUST NOT replace it. The authority's base identity MUST match the resolved branch, except for a recorded graph retarget transition verified below. That transition retains the old child-only boundary until a successful operation establishes the new base.

Before worker handoff, the gateway MUST persist the publishing owner, resolved base, selected authority, fetched target SHA and exact remote child-head SHA in the maintenance run's existing step outputs. Inline CI fixes use their existing persisted CI-watch operation state. The context survives restart and is not recaptured from the resulting checkout. Owner, base identity or remote child-lease changes during handoff require a new verified operation context, not silent substitution. A parent tip advancing on the same branch does not replace the pinned target.

### Admission and execution

The one runtime guard MUST run before any rebase or up-to-date shortcut. It MUST verify the selected branch, complete immutable SHAs, remote child-head inclusion and the authority's parent/child ancestry. Ambiguous or non-linear child ownership refuses; it is not flattened by an ordinary rebase.

For an open stack, the selected target MUST descend from the authority's parent boundary. A rewind or rewritten parent therefore refuses before changing HEAD or writing a lease. A retargeted stack instead MUST verify its recorded upstream merge in the resolved default-branch target and retain the prior child-only boundary. Retargeting is never inferred from a PR body. Ordinary runs without stack lineage retain the existing resolved-base and lease checks.

A stacked operation MUST rebase child-owned commits with `git rebase --onto <pinned-target-sha> <verified-parent-boundary> <child-branch>`. It MUST NOT use plain rebase against the live parent ref. After conflicts and required validation, publication MUST use an explicit lease against the captured remote child head. Advancing the parent during the operation does not change its pinned target; a later operation consumes the verified successor.

### Renewal and recovery

Successful pr-complete, update-branch and ci-fix completion, plus each successful inline CI-fix path, MUST call the same gateway renewal routine. The routine MUST verify the current publishing owner and base, the exact pushed child head, successful operation result and ancestry of the pinned target in that child. It captures the committed range through the existing review snapshot owner, then checks that `baseSha` equals the operation target and `headSha` equals the pushed result before persisting `maintainedSnapshot`.

The checkpoint MUST name the operation's actual target. A post-hoc merge-base cannot certify a rewind. Failed, interrupted, unavailable or mismatched operations MUST preserve the previous checkpoint and report a typed refusal. Replay, `needsReview:false` and an already-current branch cannot bypass renewal or admission. Renewal is idempotent for the same verified pair and never grants publication, review or acceptance approval.

A restarted gateway MUST use the retained operation context and checkpoint, reverify remote facts and refuse uncertainty. It MUST NOT rewrite `Run.stack.resolvedSha`, frozen package hashes or task/evidence bytes. Existing contribution comparison and default-branch freshness rules still apply.

### Consumer and conformance requirements

The gateway/task runtime MUST ship before templates and rebase helpers consume its supplied command. pr-complete, update-branch and inline CI-fix MUST use the same guard and authority selection. Standalone stacked invocations missing that context refuse; no pack parser or compatibility bypass is permitted.

Conformance MUST cover an advancing open parent, a parent rewind that would resurrect removed commits, two successive successful rebases, retarget after upstream squash-merge, narrow refspec fetches, remote-only child edits, restart during maintenance and failure after rebase before a verified push. Every refusal must preserve the previous checkpoint and retained evidence. Native Git proofs and the public gateway/SDK consumer path are required before shipping; unit fixtures alone do not establish lifecycle behavior.
