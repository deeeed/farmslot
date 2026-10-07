# Stacked work

Start a run on top of another run's PR, so B builds on A before A merges. Supports
[ADR-040](../adr/040-work-graph-orchestration.md#amendment-stacked-runs-2026-10-07).

## The one rule

A stacked run starts from the upstream PR's **pushed** branch on origin. Slots are separate
checkouts, often on other nodes; local commits never reach them. The downstream node waits
until the upstream run has published its PR.

## Set it up

Both items are backlog items in a work graph. Add two edges from the upstream node to the
stacked node:

```sh
farmslot graph create --project my-project --title "Feature A then B"
farmslot graph add-node <graphId> --id wn_a --backlog-item <itemA>
farmslot graph add-node <graphId> --id wn_b --backlog-item <itemB>

# Start B from A's published PR branch.
farmslot graph add-edge <graphId> --from wn_a --to wn_b --condition published

# When A merges, move B's PR to the default branch.
farmslot graph add-edge <graphId> --from wn_a --to wn_b --condition merged \
  --blocks completion --unlock rebase-onto

farmslot graph activate <graphId>
```

The `published` edge records A as B's stack base. A node has one stack base, and both
nodes must belong to the same project.

## What happens

1. A runs as usual and publishes its PR.
2. The `published` edge is satisfied and B is enqueued.
3. B's prepare checks A's PR on GitHub, fetches its branch from origin and creates B's
   branch from its head, on whichever slot or node B lands on.
4. B's TASK.md has a `## Stack` section: the PR it sits on, that branch, and the nodes
   stacked on B.
5. B's PR targets A's branch, and B's diff covers only B's commits.
6. When A merges, B's PR is retargeted to the default branch. Once B's run and its
   follow-ups have finished, the default branch is merged into B's head on GitHub, so B's
   diff shows only B's work. If that merge conflicts, dispatch update-branch.

If A merged before B started, B is an ordinary run from the default branch.

## Limits

- Only dev and fix-bug runs stack; other flows on the node run as usual.
- If A's PR is closed without merging, the `published` edge goes back to pending and B
  needs attention.
- The catch-up after a retarget is a merge commit, not a rebase. Dispatch update-branch if
  you want B's history rewritten onto the default branch.
- Farmslot learns that A merged from ci-watch on A's run. If A's run had already
  finished when A merged, run `farmslot graph tick <graphId>`: an operator tick asks GitHub
  about the PR B stacks on, records the merge and retargets B in the same call.
- Don't archive B while its PR is open and A hasn't merged: an archived run drops out of
  this maintenance, so you would retarget its PR by hand.
- A failed retarget shows in the graph ledger. Fix the cause, then run
  `farmslot graph tick <graphId>` to retry it.
- Runs without a `published` edge are unchanged: same branch base, same PR base, same
  TASK.md.
