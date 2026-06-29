import {
  type DecisionAction,
  DEFAULT_BRANCH,
  type DispatchPreviewParams,
  Events,
  isDispatchScoreStale,
  type Run,
  type RunDecision,
  type RunDecisionPayload,
  SLOT_DESTRUCTIVE_OPS,
  SLOT_STALE_BRANCH_SCORE_PENALTY,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { getProjectField, loadProjectVars, markSlotBusy, updateSlotStatus } from '../core/index.js';
import { loadFleetStatus, loadProjectConfigs } from '../fleet/state.js';
import {
  collectBranchAffinityNudgeCandidates,
  dispatchPreview,
  findAffinitySlot,
  prepareSlotForFreshReuse,
  refreshBranches,
  selectBranchAffinityRefreshSlots,
  verifyBranchAffinityNudgeStillEligible,
} from '../methods/dispatch.js';
import {
  isCdpLive,
  isFreeSlot,
  projectConfigsFromProjects,
  slotScore,
} from '../methods/dispatch/slot-scoring.js';
import {
  assertSlotNotOperatorRoot,
  resetSlotRepoToIdle,
  slotIdleResetStepDetail,
} from '../methods/slot/slot-tracking.js';
import { runnerDefaultSafetyTier } from '../runners/registry.js';
import { getRun, updateRun } from '../runs/store.js';
import { precheckTaskDirCollision } from '../tasks/writer.js';

interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

type BroadcastFn = (event: string, payload: unknown) => void;

interface RunEngineFlags {
  skipPrepare?: true;
  nudgeReuse?: true;
  freshReuse?: true;
}

export interface FindSlotStepContext {
  broadcastFn: BroadcastFn;
  buildDispatchPreviewParamsForRun: (run: Run) => DispatchPreviewParams;
  createEngineDecision: (
    runId: string,
    reason: string,
    description: string,
    actions: DecisionAction[],
    payload?: RunDecisionPayload,
    options?: { canReplay?: (existing: RunDecision) => boolean },
  ) => Promise<string>;
  determineSelectionMethodForRun: (
    run: Pick<Run, 'flowType'>,
    requestedSlotId: string | undefined,
    projectSlots: Array<Pick<Run, never> & { lifecycle: string; slot: string }>,
    slotId: string,
  ) => 'user-specified' | 'affinity' | 'scored';
  handleCollisionDecision: (
    runId: string,
    current: Run,
    existingDirs: string[],
    ticketSlug: string,
  ) => Promise<'create-new'>;
  requiresCollisionPrecheck: (flowType: Run['flowType']) => boolean;
  resolveRunDispatchRunnerModel: (
    run: Pick<Run, 'metrics'>,
    preview: { runner: string; model: string },
  ) => { runner: string; model: string };
  setRunFlags: (runId: string, flags: RunEngineFlags) => void;
}

export async function executeFindSlotStep(
  runId: string,
  run: Run,
  context: FindSlotStepContext,
): Promise<StepIO> {
  const {
    broadcastFn,
    buildDispatchPreviewParamsForRun,
    createEngineDecision,
    determineSelectionMethodForRun,
    handleCollisionDecision,
    requiresCollisionPrecheck,
    resolveRunDispatchRunnerModel,
    setRunFlags,
  } = context;
  const inputs: Record<string, unknown> = {
    project: run.project,
    flowType: run.flowType,
    requestedSlotId: run.slotId || undefined,
  };

  // Collision precheck — runs before slot allocation, grading, task-file
  // creation, or worker prep. The precheck itself reads the tasks dir
  // (cheap readdir) to detect collisions early so the operator can redirect
  // to a prior run before any expensive resource is claimed. The same
  // decision is replayed at WRITE_TASK (deduplicated by createEngineDecision,
  // unless the colliding dir set changed — see canReplayCollisionDecision).
  if (requiresCollisionPrecheck(run.flowType)) {
    const { existingDirs, ticketSlug } = await precheckTaskDirCollision(run);
    if (existingDirs.length > 0) {
      // Returns 'create-new' to fall through; other actions throw.
      await handleCollisionDecision(runId, run, existingDirs, ticketSlug);
    }
  }

  // Wizard-shortcut: when run.create was issued with `nudgeReuse: true` (operator picked
  // the busy branch-matched slot in the dispatch wizard), the slotId is already bound and
  // FIND_SLOT has no decision to make. Return immediately so DISPATCH can route through
  // nudgeDispatch — no fleet refresh, no candidate scoring, no card pop-up. Validation in
  // run.ts guarantees nudgeReuse + slotId travel together.
  //
  // TOCTOU protection: re-verify the slot is still nudge-eligible before short-circuiting.
  // The wizard click → run.create round-trip can take seconds; gateway restart recovery can
  // also rehydrate this branch with stale state. nudgeDispatch re-checks again at DISPATCH
  // time as belt-and-braces, but failing here gives the operator a usable error before any
  // pipeline state is mutated.
  if (run.engineState?.flags?.nudgeReuse && run.slotId) {
    const wizardSlot = (await loadFleetStatus()).slots.find((s) => s.slot === run.slotId);
    const eligibilityFail = await verifyBranchAffinityNudgeStillEligible(
      wizardSlot,
      run.project,
      run.ticketOrPr,
      {
        familyId: run.familyId ?? null,
        lane: run.lane ?? null,
        variant: run.variant ?? null,
        allowedSlots: run.allowedSlots ?? null,
        // PR head branch the wizard resolved against pr.list — exact match wins regardless
        // of whether prHealth has been populated for the slot yet.
        targetBranch: run.branch ?? null,
      },
    );
    if (eligibilityFail) {
      throw new Error(
        `Branch-affinity nudge no longer valid: ${eligibilityFail}. Pick a slot again.`,
      );
    }
    return {
      inputs,
      outputs: {
        selectedSlot: run.slotId,
        selectionMethod: 'nudge',
        branch: wizardSlot?.branch ?? null,
        via: 'wizard',
      },
    };
  }

  // freshReuse wizard-shortcut: operator picked "Kill & dispatch fresh" for a busy
  // branch-matched slot. Run.create already validated slotId + flow type. Re-verify the
  // slot is still on the expected branch + still has an active worker (TOCTOU between
  // wizard click and run.create), then hard-kill the prior worker BEFORE PREPARE runs.
  // Without this teardown order, PREPARE's git reset / checkout / dependency install
  // would race the still-writing worker in the same worktree and corrupt slot state.
  // The standard fresh-dispatch pipeline (PREPARE → DISPATCH) takes over after the slot
  // is quiescent.
  if (run.engineState?.flags?.freshReuse && run.slotId) {
    const wizardSlot = (await loadFleetStatus()).slots.find((s) => s.slot === run.slotId);
    const eligibilityFail = await verifyBranchAffinityNudgeStillEligible(
      wizardSlot,
      run.project,
      run.ticketOrPr,
      {
        familyId: run.familyId ?? null,
        lane: run.lane ?? null,
        variant: run.variant ?? null,
        allowedSlots: run.allowedSlots ?? null,
        targetBranch: run.branch ?? null,
      },
    );
    if (eligibilityFail) {
      throw new Error(`Fresh-reuse no longer valid: ${eligibilityFail}. Pick a slot again.`);
    }
    await prepareSlotForFreshReuse(run.slotId, runId);
    await markSlotBusy(run.slotId, 'preparing');
    broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
    return {
      inputs,
      outputs: {
        selectedSlot: run.slotId,
        selectionMethod: 'human-override',
        branch: wizardSlot?.branch ?? null,
        via: 'wizard-fresh-reuse',
      },
    };
  }

  // Capture candidate list before selection (live branch check for accurate scoring)
  const [fleet, projectConfigList] = await Promise.all([
    loadFleetStatus(true),
    loadProjectConfigs(),
  ]);
  const projectConfigs = projectConfigsFromProjects(projectConfigList);
  // `allowedSlots` narrows the project pool to the set the dispatch UI
  // filtered to at click time. Without this, FIND_SLOT could land the run
  // on a machine the user had just excluded via the global filter bar.
  const allowSet =
    run.allowedSlots && run.allowedSlots.length > 0 ? new Set(run.allowedSlots) : null;
  const projectSlots = fleet.slots.filter(
    (s) => s.project === run.project && (!allowSet || allowSet.has(s.slot)),
  );
  const freeSlots = projectSlots.filter(isFreeSlot);
  if (freeSlots.length > 0) await refreshBranches(freeSlots);
  // PR-bound flows resolve a `targetBranch` so slotScore flips the stale
  // penalty into a bonus for slots already on that branch. Without this,
  // the candidate preview + stale-threshold gate would flag the PR's own
  // branch-ready slot as stale and prefer a clean main slot — the exact
  // regression dispatch.candidates' targetBranch bonus is meant to avoid.
  const targetBranch =
    (run.flowType === 'review-pr' || run.flowType === 'pr-complete') && run.branch
      ? run.branch
      : undefined;
  const candidates = freeSlots.slice(0, 10).map((s) => ({
    slotId: s.slot,
    score: slotScore(s, targetBranch, { familyId: run.familyId, projectConfigs }),
    cdpLive: isCdpLive(s.health.cdp),
  }));

  // Affinity: for review-pr and pr-complete, prefer the held slot already on this branch
  if (!run.slotId && (run.flowType === 'review-pr' || run.flowType === 'pr-complete')) {
    const affinitySlot = findAffinitySlot(fleet.slots, run.project, run.ticketOrPr, {
      familyId: run.familyId,
      lane: run.lane,
      variant: run.variant ?? null,
      allowedSlots: run.allowedSlots ?? null,
    });
    if (affinitySlot) {
      console.log(
        `[run-engine] ${run.flowType} affinity: reusing slot ${affinitySlot.slot} (branch=${affinitySlot.branch})`,
      );
      updateRun(runId, { slotId: affinitySlot.slot });
      await markSlotBusy(affinitySlot.slot, 'preparing');
      broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
      return {
        inputs,
        outputs: {
          selectedSlot: affinitySlot.slot,
          selectionMethod: 'affinity',
          branch: affinitySlot.branch,
          candidateCount: freeSlots.length,
          candidates,
        },
      };
    }

    // Headless branch-affinity nudge — entry points without a wizard (CI-watch chained
    // pr-complete after CI fail, CLI dispatch, gateway restart recovery) reach here. Look
    // for a busy slot already on this PR's branch; if found, surface a decision card so
    // the operator picks nudge / fresh / pick-different / abort. Wizard-driven runs
    // bypass this path because runCreate sets flags.nudgeReuse and FIND_SLOT short-circuits
    // at the top of the case. Production lane only — collect helper short-circuits on
    // comparison lane to preserve ADR-024 §7 scrub-between-siblings.
    if (run.lane !== 'comparison') {
      const busyMatching = selectBranchAffinityRefreshSlots(projectSlots);
      if (busyMatching.length > 0) await refreshBranches(busyMatching);
      const nudgeCandidates = await collectBranchAffinityNudgeCandidates(
        fleet.slots,
        run.project,
        run.ticketOrPr,
        {
          familyId: run.familyId ?? null,
          lane: run.lane ?? null,
          variant: run.variant ?? null,
          allowedSlots: run.allowedSlots ?? null,
          // Same targetBranch the slotScore step uses — set when run.branch is the PR's
          // head branch, falsy on non-PR flows.
          targetBranch: targetBranch ?? null,
        },
      );
      if (nudgeCandidates.length > 0) {
        const top = nudgeCandidates[0];
        const prMatch = run.ticketOrPr.match(/#(\d+)$/);
        const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
        const desc = [
          `Slot **${top.slot.slot}** is already on **${top.slot.branch}** with an active ${top.slot.runner ?? 'worker'} session.`,
          top.ctxPct != null ? `Context: ${top.ctxPct}%.` : 'Context: unknown.',
          top.uncommittedCount > 0
            ? `WARNING: ${top.uncommittedCount} uncommitted file(s) — nudging will clobber nothing on disk but the worker may stomp them when it executes the new task.`
            : 'No uncommitted files.',
          top.riskFlags.length > 0 ? `Flags: ${top.riskFlags.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join('\n\n');

        const payload: import('@farmslot/protocol').BranchAffinityNudgePayload = {
          kind: 'branch_affinity_nudge',
          project: run.project,
          ticketOrPr: run.ticketOrPr,
          prNumber,
          candidate: {
            slotId: top.slot.slot,
            machine: top.slot.machine,
            branch: top.slot.branch,
            runner: top.slot.runner,
            model: top.slot.model,
            nudgeCount: top.nudgeCount,
            ctxPct: top.ctxPct,
            agentStatus: top.slot.agent,
            dispatchedAt: top.slot.dispatchedAt,
            currentRunId: top.slot.currentRunId ?? null,
            currentFlowType: top.slot.currentFlowType ?? null,
            uncommittedCount: top.uncommittedCount,
            uncommittedFiles: top.uncommittedFiles,
            prMatchKind: top.prMatchKind,
            canNudge: top.canNudge,
          },
          freeSlotCandidates: projectSlots.filter(isFreeSlot).map((s) => ({
            slotId: s.slot,
            score: slotScore(s, targetBranch, { familyId: run.familyId, projectConfigs }),
            branch: s.branch || '',
            lifecycle: s.lifecycle,
            health: s.health,
            machine: s.machine,
          })),
          riskFlags: top.riskFlags,
        };

        // Per-runner action gating: only emit the 'nudge' action when the slot's runner
        // supports tmux send-keys. For codex / opencode slots the row still surfaces (the
        // operator wants to see "this slot is on the PR's branch") but Fresh becomes the
        // primary action since Nudge would silently fail.
        const actions: Array<{
          id: string;
          label: string;
          style: 'primary' | 'secondary' | 'danger';
        }> = [];
        if (top.canNudge) {
          actions.push({
            id: 'nudge',
            label: 'Nudge worker (reuse session)',
            style: 'primary',
          });
          actions.push({ id: 'fresh', label: 'Kill & dispatch fresh', style: 'secondary' });
        } else {
          actions.push({ id: 'fresh', label: 'Kill & dispatch fresh', style: 'primary' });
        }
        actions.push({ id: 'pick', label: 'Pick different free slot', style: 'secondary' });
        actions.push({ id: 'abort', label: 'Abort', style: 'danger' });

        const actionId = await createEngineDecision(
          runId,
          'branch_affinity_nudge',
          desc,
          actions,
          payload,
        );

        if (actionId === 'abort') throw new Error('Aborted: branch-affinity nudge declined');
        if (actionId === 'nudge') {
          setRunFlags(runId, { nudgeReuse: true, skipPrepare: true });
          updateRun(runId, { slotId: top.slot.slot });
          // Use phase='working', agent='working' (NOT the default agent='idle') because the
          // slot is being reassigned to a live, mid-task worker. The next DISPATCH step
          // routes through nudgeDispatch, whose preflight re-runs collectBranchAffinityNudgeCandidates
          // and requires `slot.agent === 'working'` — flipping to idle here would make every
          // decision-card nudge fail its own eligibility recheck. The wizard-shortcut path
          // doesn't markSlotBusy at all (slot already has agent=working from the prior run);
          // this branch needs the same preservation.
          await markSlotBusy(top.slot.slot, 'working', 'working');
          broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
          return {
            inputs,
            outputs: {
              selectedSlot: top.slot.slot,
              selectionMethod: 'nudge',
              branch: top.slot.branch,
              candidateCount: freeSlots.length,
              candidates,
              via: 'decision-card',
            },
          };
        }
        if (actionId === 'fresh') {
          // The decision-card 'fresh' branch binds the busy slot AND must hard-kill the
          // prior worker BEFORE PREPARE runs — otherwise PREPARE's git reset / checkout /
          // dependency install would race against a still-writing worker in the same
          // worktree and corrupt slot state. prepareSlotForFreshReuse handles
          // terminalize-prior-run + kill-worker-on-slot in the right order.
          await prepareSlotForFreshReuse(top.slot.slot, runId);
          updateRun(runId, { slotId: top.slot.slot });
          await markSlotBusy(top.slot.slot, 'preparing');
          broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
          return {
            inputs,
            outputs: {
              selectedSlot: top.slot.slot,
              selectionMethod: 'human-override',
              branch: top.slot.branch,
              candidateCount: freeSlots.length,
              candidates,
            },
          };
        }
        // 'pick' — the decision card lets the operator pick a specific free slot inline
        // (selectionData.slotId), or decline by leaving it empty. With an explicit slot,
        // bind it directly with selectionMethod=human-override; without one, fall through
        // to the existing slot-picker / scoring flow below so the engine still dispatches
        // without re-asking.
        if (actionId === 'pick') {
          const resolvedDecision = getRun(runId)!.decisions.find(
            (d) => d.type === 'engine_branch_affinity_nudge' && d.resolvedAt,
          );
          const pickedSlotId =
            (resolvedDecision?.selectionData?.slotId as string | undefined) ?? null;
          if (pickedSlotId) {
            updateRun(runId, { slotId: pickedSlotId });
            await markSlotBusy(pickedSlotId, 'preparing');
            broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
            return {
              inputs,
              outputs: {
                selectedSlot: pickedSlotId,
                selectionMethod: 'human-override',
                candidateCount: freeSlots.length,
                candidates,
              },
            };
          }
        }
      }
    }
  }

  // Human intervention when no good candidates exist
  if (
    !run.slotId &&
    (freeSlots.length === 0 ||
      freeSlots.every((s) =>
        isDispatchScoreStale(
          slotScore(s, targetBranch, { familyId: run.familyId, projectConfigs }),
        ),
      ))
  ) {
    const reason = freeSlots.length === 0 ? 'no_free_slots' : 'all_stale';
    const allProjectSlots = projectSlots.map((s) => ({
      slotId: s.slot,
      score: isFreeSlot(s)
        ? slotScore(s, targetBranch, { familyId: run.familyId, projectConfigs })
        : -1,
      branch: s.branch || '',
      lifecycle: s.lifecycle,
      health: s.health,
      machine: s.machine,
    }));

    const desc =
      reason === 'no_free_slots'
        ? `No free slots for **${run.project}**. ${projectSlots.length} slots exist but all are busy or disabled.`
        : `All ${freeSlots.length} free slot(s) have stale branches (score >= ${SLOT_STALE_BRANCH_SCORE_PENALTY}). Pick one to reset or use as-is.`;

    const slotPickerPayload: import('@farmslot/protocol').SlotPickerPayload = {
      kind: 'slot_picker',
      project: run.project,
      candidates: allProjectSlots,
      reason,
    };

    const actionId = await createEngineDecision(
      runId,
      'no_suitable_slot',
      desc,
      [
        { id: 'pick', label: 'Use Selected Slot', style: 'primary' },
        { id: 'abort', label: 'Abort Run', style: 'danger' },
      ],
      slotPickerPayload,
    );

    if (actionId === 'abort') throw new Error('Aborted: no suitable slot');

    // User picked a slot via selectionData
    const resolvedDecision = getRun(runId)!.decisions.find(
      (d) => d.type === 'engine_no_suitable_slot' && d.resolvedAt,
    );
    const pickedSlotId = (resolvedDecision?.selectionData?.slotId as string) || null;
    if (!pickedSlotId) throw new Error('No slot selected');

    // If user requested reset, do it before proceeding
    if (resolvedDecision?.selectionData?.resetBranch) {
      const vars = await loadSlotVars(pickedSlotId);
      // Entry guard mirroring the other destructive-op call sites — never reset
      // the gateway's own operator root (resetSlotRepoToIdle also backstops this).
      await assertSlotNotOperatorRoot(vars, SLOT_DESTRUCTIVE_OPS.idleReset);
      let projectVars;
      let projectJson = {};
      try {
        projectVars = await loadProjectVars(vars.projectName);
        projectJson = projectVars.projectJson;
      } catch {
        /* no project config */
      }
      const defaultBranch = getProjectField(projectJson, 'default_branch') || DEFAULT_BRANCH;
      const idleReset = await resetSlotRepoToIdle(vars, projectJson, projectVars, defaultBranch);
      console.log(
        `[run-engine] reset ${pickedSlotId}: ${slotIdleResetStepDetail(idleReset, defaultBranch)}`,
      );
    }

    updateRun(runId, { slotId: pickedSlotId });
    await markSlotBusy(pickedSlotId, 'preparing');
    broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
    return {
      inputs,
      outputs: {
        selectedSlot: pickedSlotId,
        selectionMethod: 'human-override',
        candidateCount: freeSlots.length,
        candidates,
        resetBranch: !!resolvedDecision?.selectionData?.resetBranch,
      },
    };
  }

  const result = await dispatchPreview(buildDispatchPreviewParamsForRun(run));
  const slotId = result.preview.slotId;
  updateRun(runId, { slotId });
  // Mark slot as claimed by this run
  await markSlotBusy(slotId, 'preparing');
  // Stamp the slot's persistent runner/model fields now so the UI's slot
  // card surfaces the upcoming worker as soon as the bind happens.
  // Without this, the slot retains the previous run's runner/model until
  // DISPATCH (buildSlotClaimStatus, methods/dispatch.ts) overwrites them
  // — so operators see e.g. "cursor/composer-2.5" while a claude/opus run
  // is preparing on the slot. dispatchExecute will overwrite with its
  // final resolved values once the worker launches.
  const previewRunner = result.preview.runner;
  const previewModel = result.preview.model;
  if (previewRunner || previewModel) {
    await updateSlotStatus(slotId, {
      ...(previewRunner ? { runner: previewRunner } : {}),
      ...(previewModel && previewModel !== 'unknown' ? { model: previewModel } : {}),
    });
  }
  broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });

  // Determine selection method (use inputs.requestedSlotId, not run.slotId which was mutated by updateRun)
  const selectionMethod = determineSelectionMethodForRun(
    run,
    inputs.requestedSlotId as string | undefined,
    projectSlots,
    slotId,
  );

  // User's model/runner selection takes priority over slot/project defaults.
  // If the operator picked a runner but left model unset/unknown, resolve
  // through that runner's registry default instead of borrowing the slot's
  // runner/model (for Cursor this must be composer-2.5, not Claude's opus).
  //
  // Aside on grade.modelRecommendation: the dispatch wizard sends a default
  // `model` on every run.create (the displayed pill value), so by the time
  // we reach here metrics.model is already populated and `gradeTicket`'s
  // `if (!current.metrics.model)` guard at the GRADE step is a no-op in
  // practice — this predates the FIND_SLOT/GRADE reorder. Surfacing
  // grade.modelRecommendation in the UI without overriding an operator's
  // explicit pin needs a separate "model touched" track on the wizard +
  // run record; that's deferred outside this PR's collision-UX scope.
  const { runner: resolvedRunner, model: resolvedModel } = resolveRunDispatchRunnerModel(
    run,
    result.preview,
  );
  const metricsUpdate = {
    ...getRun(runId)!.metrics,
    runner: resolvedRunner,
    model: resolvedModel,
  };
  // If the run was created without an explicit runner or tier, safetyTier
  // is still undefined — pin it to the resolved runner's default now so
  // dispatch and chained runs see a concrete posture.
  const tierUpdate =
    run.safetyTier === undefined ? { safetyTier: runnerDefaultSafetyTier(resolvedRunner) } : {};
  updateRun(runId, { metrics: metricsUpdate, ...tierUpdate });

  return {
    inputs,
    outputs: {
      selectedSlot: slotId,
      runner: resolvedRunner,
      model: resolvedModel,
      selectionMethod,
      candidateCount: freeSlots.length,
      candidates,
    },
  };
}
