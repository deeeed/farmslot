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

The `published` edge records A as B's stack base. A node has one stack base.

## What happens

1. A runs as usual and publishes its PR.
2. The `published` edge is satisfied and B is enqueued.
3. B's prepare fetches A's branch from origin and creates B's branch from its head, on
   whichever slot or node B lands on.
4. B's TASK.md has a `## Stack` section: the PR it sits on, that branch, and the nodes
   stacked on B.
5. B's PR targets A's branch, and B's diff covers only B's commits.
6. When A merges, B's PR is retargeted to the default branch. If GitHub then reports a
   conflict, ci-watch dispatches the usual update-branch run to rebase B.

If A merged before B started, B is an ordinary run from the default branch.

## Limits

- Only dev and fix-bug runs stack; other flows on the node run as usual.
- If A's PR is closed without merging, the `published` edge goes back to pending and B
  needs attention.
- A retargeted PR that merges cleanly is not rebased automatically; dispatch update-branch
  if you want its history rewritten onto the default branch.
- Runs without a `published` edge are unchanged: same branch base, same PR base, same
  TASK.md.
