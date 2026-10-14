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

Existing contribution lineage identifies the publishing owner, including archived ancestors. Its optional `engineState.publishGate.maintainedSnapshot` is a `BranchMaintenanceCheckpoint`, extending `ReviewDiffSnapshot` with `replayBoundarySha`. `baseSha` binds the committed comparison, `headSha` binds the verified child, and `replayBoundarySha` identifies the boundary before child-owned commits. Branch names MUST normalize identically for snapshot and resolver identities, accepting the equivalent explicit remote form without inferring another branch.

Initial ownership MUST be verified against the recorded prepare stack point and existing contribution algorithm. A frozen publication snapshot may bind the child head, but its live-derived `baseSha` MUST NOT independently establish replay ownership. If a parent rewinds before capture, that merge-base may predate the recorded parent and include removed parent commits. The gateway MUST anchor the child-only range to recorded provenance or refuse uncertainty. Task prose, PR bodies and mutable diff artifacts MUST NOT supply authority.

Before handoff, the gateway MUST retain the owner, resolved base, selected checkpoint identity, verified replay boundary, fetched target SHA and exact remote child lease in existing maintenance step outputs or CI-watch operation state. The target MUST match the live remote base at pin time. Owner, base identity or child-lease changes require a new verified context. A later parent advance does not silently replace the pinned target.

### Admission and execution

One runtime guard MUST run before rebase or an up-to-date shortcut. It MUST verify branch identity, immutable SHAs, replay-boundary ancestry in the leased child, remote-only child inclusion and the existing child-ownership check. Ambiguous history refuses. A verified child-only range MUST support a parent rebased onto an advanced default branch or intentionally rewound: the new target need not descend from the old boundary. This does not authorize a stale target or replay removed parent commits.

Worker rebases MUST use `git rebase --onto <pinned-target-sha> <verified-replay-boundary> <child-branch>` with the existing ownership algorithm excluding inherited parent/default commits. Plain rebase against a rewritten live parent is forbidden. Conflicts and required validation precede an explicit push lease against the captured child head. A project or branch protection that forbids the required rewrite MUST refuse; this contract adds no worker merge fallback or policy override.

Retargeting MUST use recorded upstream merge provenance. Existing graph catch-up remains a supported merge operation. Its verified target, pre-update child and resulting merge head MUST enter the same checkpoint path. A known graph/default merge is not ambiguous child ownership: the checkpoint retains the prior replay boundary while original parent ancestry remains, so the next worker operation cannot resurrect it. Ordinary contribution comparison may already apply once the recorded upstream merge is present; retiring stack-specific replay checks additionally requires that the inherited parent ancestry has actually been removed. All transitions preserve their provenance.

### Renewal and recovery

pr-complete, update-branch and ci-fix completion, every inline CI-fix success and existing graph catch-up MUST use one gateway-owned renewal routine. It MUST verify the current owner/base, retained operation result, pinned target ancestry and exact resulting remote child head. Capture MUST use an explicit immutable committed range against the pinned target, never refetch a mutable parent to derive the operation's target. The resulting comparison `baseSha` MUST equal that target and `headSha` MUST equal the verified result. Rebases establish a new replay boundary at the target; graph merges retain the verified old replay boundary until inherited parent ancestry is removed.

Persistence MUST compare-and-set the complete expected prior checkpoint identity through the publishing owner's existing Run mutation authority. A stale renewal MUST NOT overwrite a newer checkpoint. Archived-owner writes use that same persistence owner and preserve archived lifecycle state; no parallel checkpoint file or store is permitted. Renewal never grants publication, review or acceptance approval.

A failed operation MUST preserve the previous checkpoint and report a typed refusal. A successful lease push interrupted before renewal is recoverable: restart reconciliation MUST verify the retained pre-operation lease and target, the pushed head and child-only ownership, then renew idempotently or refuse uncertainty. It MUST NOT infer success from a current merge-base or recapture operation input from the resulting checkout. An interrupted operation without a verified push, replay, `needsReview:false` and an already-current branch cannot bypass the same checks.

Prepare's `Run.stack.resolvedSha`, frozen package hashes and task/evidence bytes MUST remain unchanged. Existing contribution comparison and default-branch freshness rules still apply.

### Consumer and conformance requirements

The supplying gateway and compatible published protocol/runtime closure MUST precede template/helper cutover. All three worker flows and inline fixes consume the same generated guard and authority selection. Standalone stacked calls missing required context refuse; no pack parser or compatibility bypass is permitted.

Conformance MUST cover: parent advance; a parent rewind before initial snapshot capture; parent rebase onto an advanced default followed by child maintenance; intentional parent rewind without resurrected commits; two successive child rebases; upstream squash-merge, retarget and graph catch-up followed by ci-fix; narrow refspec fetches; remote-only child edits; concurrent stale renewal; archived publishing ownership; restart before push and after a successful push before renewal; and force-push prohibition without a policy bypass. Every refusal MUST preserve the prior checkpoint and retained evidence. Native Git and public gateway/SDK consumer proofs are required before shipping; unit fixtures alone do not establish lifecycle behavior.
