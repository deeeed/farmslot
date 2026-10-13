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
