# Recipe composition quality

The canonical contract is [Recipe Protocol v1](recipe-protocol-v1.md). This guide covers authoring judgment.

## Use the smallest useful layer

- Use an **action** for one atomic runner capability.
- Use a **recipe** for a deterministic graph that proves an outcome.
- Call another recipe when it removes repeated discovery or enforces a shared safety invariant.

Do not add a reusable recipe for a one-line action invocation. Do not add an action when existing actions can express the behavior clearly.

## Start with discovery

```bash
farmslot recipe run --list --adapter mobile
farmslot recipe run wallet.smoke --describe --adapter mobile
```

Then inspect the runner's action manifest. Call the closest recipe when its graph fits. Copy it only when the workflow itself must change, then edit only what the acceptance criteria require.

## Prefer parameters over variants

One well-named recipe with typed parameters is easier to discover than many near-duplicates.

Good:

```text
perps.ensure_market market=ETH positions=none
perps.ensure_market market=BTC positions=present
```

Avoid separate ids for each market, account, or expected state unless their graphs actually differ.

Defaults should make the common safe case runnable with no arguments. Mutation defaults should target an isolated test environment. Required parameters should represent choices that cannot be made safely.

## Compose by contract

A called recipe should:

- have a focused outcome stated in `description`;
- validate its own parameters;
- converge idempotently when named `ensure_*`;
- prove its final state with normal read/assert nodes;
- leave task-specific assertions in the parent recipe;
- avoid hidden environment assumptions.

The parent passes only the values that differ from the dependency defaults:

```json
{
  "action": "call",
  "ref": "wallet.ensure_unlocked",
  "params": { "account": "dev1" },
  "intent": "Prepare the proof account",
  "next": "verify"
}
```

For a task recipe at `artifacts/recipe.json`, keep task-only dependencies in the sibling `artifacts/recipe-library/`; runners discover it automatically. Promote recipes to a shared library only after reuse is proven.

## Keep proof readable

Each node intent should explain the current human-visible goal, not repeat the action name, selector, or node id. Use setup for preparation, proof nodes for the claim, and teardown only when cleanup is part of the contract.

Prefer state/log assertions for non-visual claims. For visual claims, wait for the claimed target and inspect the captured image. One artifact should map clearly to one proof target.

## Library review checklist

- The id follows the `recipes/` path and is easy to guess.
- Title, description, parameters, defaults, and enums are sufficient for `--describe`.
- Generic and adapter-specific files do not duplicate the same graph unnecessarily.
- Calls resolve statically and the graph is acyclic.
- The recipe is safe with defaults and explicit about mutations.
- The same recipe runs directly and as a nested call.
- A passing run emits exact dependency evidence in `recipe-resolution.json`.

If a recipe does not reduce inference, improve safety, or encode a reusable proof contract, keep it task-local.

## Shared shape feedback

ADR-026 Amendment 3 defines the shared advisory scorer. The policy is versioned;
run-time recipe quality and the dataset MUST call the same implementation.

### Inputs and results

Inputs are a Recipe v1 document, expected registered worker criteria and the
available declared-library block catalog. Expected criteria use the protocol
registered-acceptance projection over handoff plus acceptance-registration inputs. A caller MUST use the task's declared sources, rather than
an unrelated mutable checkout, and identify the recipe and catalog it scored.
When comparing runtime and offline results, use the same policy and inputs.
Offline block mining is a retrieval/repair aid, not permission to alter a recorded
run's comparison catalog.

The catalog is bounded to 2,048 blocks and 8 MiB of serialized block metadata.
Its identity is a digest of ordered block IDs/content and declared source
fingerprints/revisions. A missing or oversized catalog is unavailable; do not
truncate it and report full composition. `recipe-resolution.json` alone is not
the complete catalog. `end` nodes do not count; `call` nodes do. With no counted
values, the parameterized score is 1, while executable-node/AC requirements still
apply.

Scores retain the dataset's existing rules:

| Dimension     | Definition                                                                               | Target |
| ------------- | ---------------------------------------------------------------------------------------- | ------ |
| Short         | 1 through 8 executable nodes, decreasing linearly to 0 at 40                             | ≥ 0.6  |
| Composed      | 1 minus the share of executable nodes duplicating available blocks                       | ≥ 0.8  |
| Parameterized | Templated values divided by templated plus literal values, under the shared field policy | ≥ 0.7  |

An empty executable graph is not good shape. Shared field classification and block
matching belong to the scorer, not a Python or gateway copy. Results include the
policy version, input identities, raw counters, scores, threshold warnings and
concrete improvement hints. Hints name literal node fields to lift into typed
`paramsSchema`/`params` and node sequences to replace with a named shared block.
They MUST NOT change the recipe or invent a matching block.

Static AC feedback lists registered worker IDs missing from reachable proving
nodes. Derived criteria use their registered modes. Existing qualified inherited
parent evidence is separate from fresh worker obligations and is not a child
proving node. Review-mode fresh obligations are listed separately and remain
uncovered for recipe imitation eligibility; adding `proves` to them is invalid.
A recipe-declared review mode cannot waive an original obligation. Empty or unavailable expected criteria cannot produce an AC-bearing
imitation candidate. A shape-qualified task-proof candidate needs nonempty,
complete static AC coverage; execution success and accepted evidence remain
separate labels. A diagnostic recipe cannot substitute its own smaller target set
for the task's registered ACs.

### Worker loop and artifact

After the task recipe passes, Farm-generated TASK.md guidance requests
`RECIPE_QUALITY_FEEDBACK_CMD` resolved to the installed task-local
`farmslot-agent recipe-quality feedback --task <task>` helper. Read the scores and AC hints
before completing. Improve and rerun the recipe until the targets are reached, or
record the specific remaining limitation and why. A graph change requires fresh
proof; editing a quality artifact is not a rerun.

The Farm generator adds the advisory instruction in TASK.md's existing proof
section only. It does not edit library-owned CHECKLIST.md, and standalone/org
skill generation does not opt in by default.

Feedback is retained in the optional `shape` field of
`artifacts/recipe-quality.json`. The slot helper computes it from bound inputs,
including recipe/registered-criteria/catalog identities. Store the portable
catalog separately at `artifacts/recipe-shape-catalog.json`, retained through the
existing portable artifact lists. `shape` carries only digests, counters, scores,
coverage and hints; never embed the up-to-8-MiB catalog in a gate decision or
family snapshot. Preserve existing core artifact fields. If absent, the existing
builder creates a worker-source advisory placeholder; the helper must not stamp
it as gateway-produced. The gateway derives its core verdict as before and
independently recomputes/merges only a matching shape contribution. Recompute the catalog digest and compare declared source identities with the
frozen `artifacts/harness-provenance.json` binding receipt. Mark a matching
snapshot worker-supplied/self-consistent; this is not proof of catalog completeness.
The dataset must independently reconstruct the catalog from verified frozen
declared sources for imitation selection; absent that, eligibility is unknown.
Unavailable source identity is explicit and never certified.
A changed recipe, criterion registration, policy or catalog invalidates that contribution;
show stale/unavailable and request feedback again, never reuse an old passing
shape. No remote checkout reads or full-library scans happen on gateway reads. Existing version-1 artifacts remain
readable. The command prints the same feedback it writes. It reads only the bound
recipe, registration and declared libraries; it MUST NOT run validation, contact
model providers or scan unrelated repositories.

Shape and static-coverage deficiencies are warnings inside `shape`; the core
verdict, semantic grade and leaderboard score remain unchanged. Historical
artifacts without shape retain their existing structural grade. There is no
background rewrite. These are advisory warnings. They MUST NOT add a
completion or publication block, alter acceptance verdicts, waive evidence rules or
create another gate. Malformed input remains an explicit input error; missing
context is reported as unavailable, not scored as a pass. The existing structural
validator remains authoritative for structural failures.
