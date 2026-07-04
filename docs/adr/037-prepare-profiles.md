# ADR-037: Prepare Profiles — Project-Defined Slot Entry Points

**Status:** Accepted
**Date:** 2026-06-13
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-022](022-slot-lifecycle-simplification.md), [ADR-031](031-deterministic-first-auto-recovery.md)
**Reference:** [Prepare lifecycle](../../apps/docs/docs/reference/prepare-lifecycle.md)

## Context

The prepare phase is one hardcoded pipeline (`services/gateway/src/methods/slot/prepare.ts`):
ssh check → device check → origin/HEAD reset → branch checkout/reset → optional
merge → fixtures → deps (`post_merge_install`) → tmux → `preflight` →
`health_check` (+`unlock` retry). Projects can only swap the command string inside
each phase; they cannot change which phases run or offer more than one way to
bring a slot up.

"Warm" reuse is a binary flag, not a concept. `skipPrepare` skips the entire
pipeline; `skip_prepare_requires_health: true` (set by exactly one project)
gates the skip behind a single live `health_check` + `ready_indicator` match and
falls back to **full** prepare on failure. There is nothing between "everything"
(20+ min for a mobile build) and "nothing".

Concrete gaps this causes:

- **MetaMask relaunch:** switching an already-built slot to another branch and
  relaunching the app should be a minutes-long operation (checkout + fixtures +
  incremental rebuild/relaunch). Today the only options are full prepare or a
  warm skip that assumes the app is already up on the right branch.
- **Backend/headless projects:** a project whose readiness is "deps installed,
  tests runnable" must still flow through a pipeline shaped around dev servers
  and device health, and the warm path's single-indicator check fits poorly.
- **Hidden prior art:** `--var key=val` → `FARMSLOT_VAR_<KEY>` (preflight-only
  env) already lets example-browser-farm pick a launch shape
  (`FARMSLOT_VAR_MODE=fullscreen|sidepanel`). It works but is undiscoverable,
  unvalidated, and invisible to the dispatch wizard. Projects already declare
  multiple worker-template variants per flow; prepare has no equivalent.

## Decision

Projects declare **named prepare profiles** in `project.json`. A profile is a
contract for the slot's end state: which framework phases run, which hooks they
use, and which machine-checkable preconditions must hold for the cheap path to
be valid.

```jsonc
"prepare": {
  "default": "full",
  "profiles": {
    "full": { "phases": ["git", "fixtures", "deps", "preflight", "health"] },
    "relaunch": {
      "label": "Switch branch + relaunch app",
      "phases": ["git", "fixtures", "preflight", "health"],
      "hooks": { "preflight": "bash {{farmslot_dir}}/projects/<name>/setup/relaunch.sh {{slot_id}} --cdp-port {{cdp_port}}" },
      "requires": ["deps_current", "dev_server_up"],
      "fallback": "full"
    },
    "attach": { "phases": ["health"], "requires": ["health_ok"], "fallback": "full" }
  }
}
```

1. **Phases.** A profile selects a subset of the optional cost phases:
   `git` (branch sync), `fixtures`, `deps`, `preflight`, `health`. Safety
   invariants always run regardless of profile: ssh reachability, device
   existence, tmux session, prepare sentinel/lock, origin/HEAD guard (when `git`
   runs). `mergeMain` stays a run-level parameter applied inside the `git`
   phase; it is flow-driven, not profile-driven.
2. **Per-profile hook overrides.** A profile may override any hook for its run
   (e.g. `relaunch` swaps `preflight` for an incremental relaunch script).
   Unoverridden hooks resolve from the top-level `hooks` block as today. In
   addition, every hook invocation exports `FARMSLOT_PREPARE_PROFILE=<name>` so
   a project can keep one preflight script and branch internally — both styles
   supported, project's choice.
3. **Preconditions with declared fallback.** `requires` names framework checks
   that must pass before the profile runs; any failure falls back to the
   profile named in `fallback` (transitively, ending at a profile with no
   `requires`) with the reason logged as a prepare sub-step. Initial check
   vocabulary:
   - `deps_current` — lockfile-hash sentinel matches the installed tree,
   - `dev_server_up` — existing `dev_server_check` hook exits 0,
   - `health_ok` — existing `health_check` + `ready_indicator` pipeline passes,
   - `artifact_available` — project `artifact_check` hook exits 0 (a fast,
     seconds-scale probe that only reports whether the profile's prebuilt
     artifact could be resolved — never a download or install).
     Checks are framework-owned names bound to project hooks, mirroring how
     `health` already works. The vocabulary can grow; projects never define new
     check semantics inline.
4. **Operator-driven selection.** The dispatch wizard and CLI
   (`--prepare-profile <name>`, `run.create` param) select a profile;
   `prepare.default` applies when unset. An optional per-flow-type default map
   may follow once real usage shows stable patterns — not in the first slice.
5. **Skip stays binary; the warm hack dies.** `skipPrepare` remains as the one
   clean orthogonal concept it should have been: "run no preparation at all" —
   the operator (or engine sequencing, e.g. `dispatchExecute(skipPrepare:
true)` after PREPARE already completed) takes responsibility for slot state,
   and no health gating is attached to it. Everything between skip and full —
   readiness assurance before dispatch — is the job of prepare profiles, which
   are variations of preparation, each ending in its own readiness checks. The
   `skip_prepare_requires_health` schema prop and the run-engine warm-reuse
   special case are deleted: their use case ("reuse if healthy, else rebuild")
   is a minimal profile (e.g. `attach` with `phases: ["health"]`, `fallback:
"full"`), not a gated skip. Projects with no `prepare` block behave exactly
   as today: a single implicit `full` profile.

## Consequences

- Warm/cold becomes a continuum: projects define as many entry points as they
  have meaningful slot states, each with an honest precondition check and a
  deterministic fallback instead of all-or-nothing.
- The MetaMask branch-switch relaunch and backend-style "deps only" prepares are
  expressible without touching framework scripts, keeping the
  no-project-specific-logic-in-scripts rule intact.
- Prepare sub-steps gain profile provenance (selected profile, checks run,
  fallback reason), which auto-recovery (ADR-031) and run observability can
  consume.
- Schema cost: one new framework-generic `prepare` block (like `hooks`); profile
  contents stay project-owned. The preflight-only `FARMSLOT_VAR_*` mechanism
  remains for orthogonal launch parameters but stops being the de-facto way to
  express entry points.
- Risk: a project can declare a profile whose phases under-prepare the slot for
  a given flow (e.g. `attach` for a review that needs a fresh merge). Mitigated
  by fallback checks plus keeping flow-critical behavior (mergeMain, branch
  drift checks) run-level rather than profile-level.

Out of scope for this ADR: automatic cheapest-profile selection by the gateway,
per-flow-type default maps, and profile-aware slot scoring in `dispatch.ts` —
each follows only after operator-driven selection proves the model.
