import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type QueueItem,
  ReviewQaConfigurationError,
  type Run,
  type RunCreateParams,
  type SlotStatus,
  type SourceConfiguration,
  type SourceLock,
  type SourceMaterialization,
  type SourceNodeStatus,
  type SourcesPinParams,
  type SourcesPinResult,
  type SourcesUnpinParams,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import {
  configureProjectSources,
  currentProjectSources,
  type ProjectSourceContext,
  resolveSlot,
  withLegacyProjectSources,
  withProjectSources,
} from '@farmslot/slot-config';
import {
  assertSourceAttestation,
  sourceInputsDigest,
  SourceMaterializer,
} from '@farmslot/slot-config/sources';

import { GatewayMethodError } from '../core/method-error.js';
import { assertNodeReconnectCurrent, sendNodeRequest, waitForNode } from '../fleet/node-rpc.js';
import { loadFleetStatus, loadPoolConfigs, loadProjectConfig } from '../fleet/state.js';
import type { RunCreateInternalOptions, RunCreationPlan } from '../methods/run.js';
import { RunTransitionCoordinator } from '../run-lifecycle/transition-coordinator.js';
import { buildRunRecord, getAllRuns, getRun, persistRunNow, updateRun } from '../runs/store.js';
import { currentSessionOriginator, runWithPrincipalOwner } from '../security/work-originator.js';

import { type PreparedSourcePins, SourceAuthority } from './authority.js';
import {
  announceSourceChanges,
  noteAuthorityFacts,
  noteRunSourceFacts,
  noteRunSourceWrite,
  noteSourceMaterialized,
} from './change-signal.js';
import { captureRunCreationRequest } from './creation-request.js';
import { assertSourcePinTarget } from './pin-target.js';
import {
  admitPlannedRunSources,
  refreshPlannedRunSources,
  type SourceAdmissionTarget,
  SourcePlanRestart,
} from './run-admission.js';
import {
  planProspectiveSlotSources,
  planRunSlotSources,
  type ProspectiveSlotSourcePlan,
  type ProspectiveSlotSourcePlans,
  type RunSlotSourcePlans,
} from './slot-planning.js';

let authority: SourceAuthority | undefined;
let gateway: SourceMaterializer | undefined;
let stopReconciliation: (() => void) | undefined;
const runSourceMutations = new RunTransitionCoordinator();

export const withRunSourceMutation = <T>(runId: string, operation: () => Promise<T>): Promise<T> =>
  runSourceMutations.withRunWhileMachineHeld(runId, operation);

export class SourceAdmissionRefusal extends Error {
  readonly code = 'SOURCE_ADMISSION_REFUSED';
}

export function sourceAuthority(): SourceAuthority | undefined {
  return authority;
}

export async function completeRunSourceCreation(runId: string): Promise<void> {
  if (!authority) throw new SourceAdmissionRefusal('Source authority disappeared during creation');
  await authority.completeRunCreation(runId);
}

export async function gatewaySourceStatus(): Promise<SourceNodeStatus | undefined> {
  return gateway?.status();
}

/** What `sources.status` reports from the authority, without per-poll timestamps. */
function sourceFactsSignature(source: SourceAuthority): string {
  return JSON.stringify([
    source.configuration.revision,
    source.pinRevision(),
    source.pins(),
    source.locks().map((lock) => [lock.context, lock.generation, lock.digest]),
    source.resolutions().map((resolution) => ({ ...resolution, resolvedAt: undefined })),
  ]);
}

/** Gateway receipts become readable through `sources.status` when materialization returns. */
class ObservedSourceMaterializer extends SourceMaterializer {
  override async materialize(lock: SourceLock): Promise<SourceMaterialization> {
    const result = await super.materialize(lock);
    noteSourceMaterialized(this.nodeId, lock.digest);
    return result;
  }
}

/** The private farm declaration file is outside every pack it bootstraps. */
export async function initializeSources(): Promise<void> {
  const home = farmslotHome();
  const configFile = process.env.FARMSLOT_SOURCES_CONFIG ?? path.join(home, 'sources.json');
  let configuration: SourceConfiguration;
  try {
    configuration = JSON.parse(await readFile(configFile, 'utf8'));
  } catch (error) {
    // Before staged cut-over, legacy runs remain on their original inputs. Explicit opt-in
    // or prior authority state can never fall back when the declaration file disappears.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || process.env.FARMSLOT_SOURCES_CONFIG)
      throw error;
    try {
      await readFile(path.join(home, 'sources', 'authority.json'));
    } catch (stateError) {
      if ((stateError as NodeJS.ErrnoException).code !== 'ENOENT') throw stateError;
      return;
    }
    throw new Error('Source declarations disappeared after cut-over');
  }
  authority = await SourceAuthority.open(configuration, path.join(home, 'sources'));
  const opened = authority;
  announceSourceChanges();
  // Restored runs need a baseline too, or their first update after a restart is never compared.
  for (const run of getAllRuns()) noteRunSourceFacts(run);
  // The first notification, the immediate first poll, records the startup baseline.
  opened.observe(() => noteAuthorityFacts(sourceFactsSignature(opened)));
  await authority.recoverRunCreations((runId) =>
    Boolean(getRun(runId)?.sourcePlan || getRun(runId)?.sourceProvenance),
  );
  gateway = new ObservedSourceMaterializer('gateway', path.join(home, 'sources', 'gateway'));
  // Configure fail-closed reads immediately; each closure becomes available as
  // its own sources finish, without waiting for an unrelated repository.
  configureProjectSources(projectContext, () => Object.keys(configuration.packs));
  stopReconciliation = authority.startReconciliation((id, error) => {
    console.error(`[sources] ${id} persistence failed; admission must reconcile:`, error);
  });
}

export function stopSourceReconciliation(): void {
  stopReconciliation?.();
  stopReconciliation = undefined;
}

export async function projectContext(
  project: string,
  context: Pick<SourceLock['context'], 'nodeId' | 'runId'> = {},
  prepared?: PreparedSourcePins,
): Promise<ProjectSourceContext> {
  if (!authority || !gateway) throw new Error('Source authority is unavailable');
  const lock = await authority.lock({ project, ...context }, prepared);
  const materialization = await gateway.materialize(lock);
  assertSourceAttestation(lock, 'gateway', materialization);
  return {
    project,
    pack: authority.configuration.packs[project],
    materialization,
    packs: lock.packBindings,
  };
}

export async function withSourcePlanning<T>(
  project: string,
  operation: () => Promise<T>,
  context: Pick<SourceLock['context'], 'nodeId' | 'runId'> = {},
): Promise<T> {
  if (!authority) return operation();
  let selected: ProjectSourceContext;
  try {
    selected = await projectContext(project, context);
  } catch (error) {
    throw new SourceAdmissionRefusal((error as Error).message, { cause: error });
  }
  return withProjectSources(selected, operation);
}

async function nodeMaterialization(
  nodeId: string,
  lock: SourceLock,
): Promise<SourceMaterialization> {
  const node = await waitForNode(nodeId, 0);
  assertNodeReconnectCurrent();
  const result = (await sendNodeRequest(
    node,
    'sources.materialize',
    { lock },
    { timeout: 120_000, requireSameConnection: true },
  )) as SourceMaterialization;
  assertSourceAttestation(lock, nodeId, result);
  noteSourceMaterialized(nodeId, lock.digest);
  return result;
}

async function runNodeId(run: Run): Promise<string | undefined> {
  if (run.reviewWorkspaceTarget) return run.reviewWorkspaceTarget.machine;
  if (!run.slotId) return run.sourcePlan?.lock.context.nodeId;
  const pool = (await loadPoolConfigs()).find((pool) =>
    pool.slots.some((slot) => slot.id === run.slotId),
  );
  if (!pool) throw new Error('Run execution node is unknown');
  return pool.machine;
}

export async function replanSourceRun(run: Run, target: SourceAdmissionTarget): Promise<Run> {
  const request = run.dispatchRequest;
  if (!request) throw new Error('Provisional run has no retained dispatch request');
  const { planRunCreation } = await import('../methods/run.js');
  const replan = () =>
    planRunCreation(
      {
        ...structuredClone(request),
        ...(target.slotId ? { slotId: target.slotId } : {}),
        familyId: run.familyId,
        parentRunId: run.parentRunId ?? undefined,
        familyRootTicketOrPr: run.familyRootTicketOrPr,
      },
      {
        replanningRunId: run.id,
        prWork: run.prWork,
        workflowExecution: run.workflowExecution,
        reviewQaContract: run.reviewQaContract,
      },
    );
  // A delegated static review replans as its native owner, not its requester.
  const plan =
    run.requestedByPrincipalId && run.createdByPrincipalId
      ? await runWithPrincipalOwner({ ownerId: run.createdByPrincipalId }, replan)
      : await replan();
  const originalQa = run.qaAfterReview;
  const plannedQa = plan.qaAfterReview;
  if (
    originalQa?.version !== plannedQa?.version ||
    !isDeepStrictEqual(originalQa?.selection, plannedQa?.selection) ||
    !isDeepStrictEqual(originalQa?.execution, plannedQa?.execution) ||
    !isDeepStrictEqual(originalQa?.review, plannedQa?.review)
  )
    throw new Error('Automatic QA admission contract changed during source revalidation');
  const next = buildRunRecord(plan.params, {
    runId: run.id,
    createdByPrincipalId: run.createdByPrincipalId,
    createdByPrincipalGeneration: run.createdByPrincipalGeneration,
    nativeOwnerPrincipalId: run.nativeOwnerPrincipalId,
    dispatchRequest: run.dispatchRequest,
    workflowExecution: plan.workflowExecution,
    reviewQa: plan.reviewQa,
    qaAfterReview: originalQa,
    directReviewPublication: plan.directReviewPublication,
  });
  return {
    ...run,
    ...next,
    slotId: target.requestedSlotId ?? run.slotId,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    steps: run.steps,
    decisions: run.decisions,
    queuedAt: run.queuedAt,
    createdByPrincipalId: run.createdByPrincipalId,
    createdByPrincipalGeneration: run.createdByPrincipalGeneration,
    nativeOwnerPrincipalId: run.nativeOwnerPrincipalId,
    executionTemplate: plan.executionTemplateSnapshot,
    engineState: { ...next.engineState, ...run.engineState },
  };
}

export async function planRunSourceSlots(
  run: Run,
  slots: readonly Pick<SlotStatus, 'slot' | 'machine' | 'project'>[],
  prepared?: PreparedSourcePins,
): Promise<RunSlotSourcePlans | undefined> {
  if (!run.sourcePlan) return undefined;
  if (!authority || !gateway) throw new SourceAdmissionRefusal('Source authority is unavailable');
  const [{ projectConfigsFromProjects }, { buildDispatchPreviewParamsForRun }] = await Promise.all([
    import('../methods/dispatch/slot-scoring.js'),
    import('../run-engine/dispatch-policy.js'),
  ]);
  const materializer = gateway;
  const resolver = authority;
  return planRunSlotSources(run, slots, {
    authority: { lock: (context) => resolver.lock(context, prepared) },
    getRun,
    gatewayMaterialization: (lock) => materializer.materialize(lock),
    replan: replanSourceRun,
    params: (planned) => ({
      ...buildDispatchPreviewParamsForRun(planned),
      ...(planned.qa ? { qaProfileId: planned.qa.profile.id, qaInputs: planned.qa.inputs } : {}),
      ...(planned.metrics.runner ? { runner: planned.metrics.runner } : {}),
      ...(planned.metrics.model ? { model: planned.metrics.model } : {}),
      ...(planned.engineState?.flags?.skipPrepare ? { skipPrepare: true } : {}),
    }),
    projectConfigs: async () => {
      const project = await loadProjectConfig(run.project);
      if (!project) throw new Error('Locked project configuration is unavailable');
      return projectConfigsFromProjects([project]);
    },
  });
}

export async function planSourceRequestSlots(
  params: RunCreateParams,
  options: RunCreateInternalOptions = {},
): Promise<ProspectiveSlotSourcePlans | undefined> {
  if (!authority) return undefined;
  if (!gateway) throw new SourceAdmissionRefusal('Source authority is unavailable');
  const resolver = authority;
  const materializer = gateway;
  const [{ planRunCreation }, { projectConfigsFromProjects }] = await Promise.all([
    import('../methods/run.js'),
    import('../methods/dispatch/slot-scoring.js'),
  ]);
  const fleet = await loadFleetStatus(true);
  const slots = fleet.slots.filter(
    (slot) =>
      slot.project === params.project &&
      (!params.slotId || slot.slot === params.slotId) &&
      (!params.allowedSlots?.length || params.allowedSlots.includes(slot.slot)) &&
      !slot.missingFromPool &&
      slot.lifecycle !== 'disabled' &&
      slot.lifecycle !== 'manual',
  );
  return planProspectiveSlotSources(
    params.project,
    slots,
    {
      authority: {
        lock: (context) => resolver.lock(context, options.sourceCreationPins),
      },
      gatewayMaterialization: (lock) => materializer.materialize(lock),
      plan: (slotId) =>
        planRunCreation(
          { ...structuredClone(params), slotId },
          { ...options, beforeCreateAsync: undefined, sourceCreationSeal: undefined },
        ),
      params: (plan) => ({
        ...plan.params,
        slotId: params.slotId,
        targetBranch: ['review-pr', 'pr-complete', 'qa'].includes(plan.params.flowType)
          ? plan.params.branch
          : undefined,
        ...(plan.reviewQa
          ? { qaProfileId: plan.reviewQa.qa?.profile.id, qaInputs: plan.reviewQa.qa?.inputs }
          : {}),
      }),
      projectConfigs: async () => {
        const project = await loadProjectConfig(params.project);
        if (!project) throw new Error('Locked project configuration is unavailable');
        return projectConfigsFromProjects([project]);
      },
    },
    options.sourceCreationRunId,
  );
}

export type SourceCreationSeal = <T>(create: () => T) => Promise<T>;
type SourceCreationCandidate = Pick<ProspectiveSlotSourcePlan, 'sources' | 'creationPlan'>;

/** Preview and queue planning reuse the creation producer without calling its publication seal. */
export function withSourceRequestPlanning<T>(
  params: RunCreateParams,
  purpose: 'preview' | 'queue',
  read: (plan?: RunCreationPlan, planning?: RunCreateInternalOptions) => Promise<T>,
): Promise<T> {
  return withSourceCreationPlan(
    params,
    { sourcePlanningPurpose: purpose },
    (plan, _seal, _runId, planning) => read(plan, planning),
  );
}

export function queuedSourceCreationRequest(item: QueueItem): RunCreateParams {
  return captureRunCreationRequest({
    ...item,
    parentRunId: item.parentRunId ?? undefined,
    branch: item.branch ?? undefined,
    allowedSlots: item.allowedSlots ?? undefined,
    startRef: item.startRef?.requestedRef,
    startRefSource: item.startRef?.source,
  });
}

export async function planQueuedSourceSlots(
  item: QueueItem,
): Promise<ProspectiveSlotSourcePlans | undefined> {
  if (!authority) {
    if (item.sourceSelections !== undefined) throw new Error('Sources are not configured');
    return undefined;
  }
  const params = queuedSourceCreationRequest(item);
  const originator = currentSessionOriginator();
  const runId = params.sourceSelections?.length ? randomUUID() : undefined;
  const prepared = runId
    ? await authority.prepareRunSelections(
        runId,
        params.sourceSelections!,
        originator.kind === 'principal' ? originator.principalId : 'system',
      )
    : undefined;
  return planSourceRequestSlots(params, {
    sourceCreationRunId: runId,
    sourceCreationPins: prepared,
    sourcePlanningPurpose: 'queue',
    workflowExecution: item.workflowExecution,
    reviewQaContract: item.reviewQaContract,
  });
}

export async function withSourceCreationPlan<T>(
  params: RunCreateParams,
  options: RunCreateInternalOptions,
  operation: (
    plan?: RunCreationPlan,
    seal?: SourceCreationSeal,
    runId?: string,
    planning?: RunCreateInternalOptions,
  ) => Promise<T>,
): Promise<T> {
  if (!authority) {
    if (params.sourceSelections !== undefined) throw new Error('Sources are not configured');
    return operation();
  }
  const resolver = authority;
  if (params.sourceSelections !== undefined && !Array.isArray(params.sourceSelections))
    throw new Error('Source selections must be an array');
  const runId = params.sourceSelections?.length ? randomUUID() : undefined;
  const originator = currentSessionOriginator();
  const prepared = runId
    ? await resolver.prepareRunSelections(
        runId,
        params.sourceSelections!,
        originator.kind === 'principal' ? originator.principalId : 'system',
      )
    : undefined;
  options = { ...options, sourceCreationRunId: runId, sourceCreationPins: prepared };
  let candidate: SourceCreationCandidate | undefined;
  const reasons: string[] = [];
  let configurationError: ReviewQaConfigurationError | undefined;
  if (
    params.reviewWorkspaceTarget ||
    (params.flowType === 'review-pr' && params.reviewValidationDepth !== 'full-live')
  ) {
    const { planRunCreation } = await import('../methods/run.js');
    for (const pool of await loadPoolConfigs()) {
      if (params.reviewWorkspaceTarget && pool.machine !== params.reviewWorkspaceTarget.machine)
        continue;
      if (!pool.reviewWorkspaces) continue;
      try {
        const sources = await projectContext(
          params.project,
          { nodeId: pool.machine, ...(runId ? { runId } : {}) },
          prepared,
        );
        const creationPlan = await withProjectSources(sources, () =>
          planRunCreation(
            { ...structuredClone(params), reviewWorkspaceTarget: { machine: pool.machine } },
            { ...options, beforeCreateAsync: undefined, sourceCreationSeal: undefined },
          ),
        );
        candidate = { sources, creationPlan };
        break;
      } catch (error) {
        // A scoped node refusal must not hide another eligible workspace's complete inputs.
        reasons.push(`${pool.machine}: ${(error as Error).message}`);
        if (error instanceof ReviewQaConfigurationError) configurationError ??= error;
      }
    }
  } else {
    const plans = await planSourceRequestSlots(params, options);
    const first = [...(plans?.values() ?? [])].find((plan) => 'creationPlan' in plan);
    if (first && 'creationPlan' in first) candidate = first;
    for (const plan of plans?.values() ?? []) {
      if ('refusal' in plan) configurationError ??= plan.configurationError;
    }
    reasons.push(
      ...[...(plans?.entries() ?? [])].map(
        ([slotId, plan]) =>
          `${slotId}: ${'refusal' in plan ? plan.refusal : 'no valid source plan'}`,
      ),
    );
  }
  if (!candidate) {
    if (configurationError) throw configurationError;
    throw new SourceAdmissionRefusal(`No valid source plan for creation:\n${reasons.join('\n')}`);
  }
  const selected = candidate;
  await options.beforeCreateAsync?.();
  const seal: SourceCreationSeal = (create) =>
    prepared
      ? resolver.publishPins(
          prepared,
          [selected.sources.materialization.lock],
          () => undefined,
          create,
        )
      : resolver.withCurrentLock(selected.sources.materialization.lock, async () => create());
  return withProjectSources(selected.sources, () =>
    operation(selected.creationPlan, seal, runId, options),
  );
}

async function mutateRunSourcePlan(
  runId: string,
  target: SourceAdmissionTarget,
  operation: typeof admitPlannedRunSources,
): Promise<void> {
  if (!authority || !gateway) throw new SourceAdmissionRefusal('Source authority is unavailable');
  const resolver = authority;
  const materializer = gateway;
  try {
    await withRunSourceMutation(runId, () =>
      operation(runId, target, {
        authority: resolver,
        getRun,
        gatewayMaterialization: (lock) => materializer.materialize(lock),
        nodeMaterialization,
        replan: replanSourceRun,
        save: async (run) => {
          updateRun(run.id, run);
          await persistRunNow(getRun(run.id)!, 'source admission');
          // Readable now, before the engine's next run.updated.
          noteRunSourceWrite(getRun(run.id)!);
        },
      }),
    );
  } catch (error) {
    if (error instanceof SourcePlanRestart) throw error;
    throw new SourceAdmissionRefusal((error as Error).message, { cause: error });
  }
}

export const admitRunSources = (runId: string, target: SourceAdmissionTarget): Promise<void> =>
  mutateRunSourcePlan(runId, target, admitPlannedRunSources);

export const refreshRunSourcePlan = (runId: string, target: SourceAdmissionTarget): Promise<void> =>
  mutateRunSourcePlan(runId, target, refreshPlannedRunSources);

/** Run pins and admission share one run boundary; all scopes share the authority seal. */
export async function mutateSourcePin(
  params: SourcesPinParams | SourcesUnpinParams,
  actor: string,
  selection: 'branch' | 'main',
  authorize: () => void,
): Promise<SourcesPinResult> {
  if (!authority) throw new Error('Sources are not configured');
  const resolver = authority;
  const execute = async (): Promise<SourcesPinResult> => {
    let pools = await loadPoolConfigs();
    const owned = params.scope === 'run' ? getRun(params.targetId) : undefined;
    const original = owned ? structuredClone(owned) : undefined;
    const assertTarget = (): void => {
      authorize();
      const current = params.scope === 'run' ? getRun(params.targetId) : undefined;
      assertSourcePinTarget(params, {
        activatedAt: resolver.activatedAt(),
        knownNodes: pools.map((pool) => pool.machine),
        run: current,
      });
      if (
        original &&
        (current?.createdByPrincipalId !== original.createdByPrincipalId ||
          current?.nativeOwnerPrincipalId !== original.nativeOwnerPrincipalId ||
          current?.sourcePlan?.lock.digest !== original.sourcePlan?.lock.digest ||
          (current?.engineState?.generation ?? 0) !== (original.engineState?.generation ?? 0))
      )
        throw new GatewayMethodError(
          'SOURCE_STATE_STALE',
          'Run ownership or source plan changed during pinning',
        );
    };
    const prepared = await resolver.preparePinMutation(params, actor, selection, assertTarget);
    if (!('pins' in prepared)) {
      authorize();
      return prepared;
    }
    let planned: Run | undefined;
    const locks: SourceLock[] = [];
    if (original) {
      if (original.reviewWorkspaceTarget) {
        const sources = await projectContext(
          original.project,
          {
            runId: original.id,
            nodeId: original.reviewWorkspaceTarget.machine,
          },
          prepared,
        );
        planned = await withProjectSources(sources, () =>
          replanSourceRun(original, {
            nodeId: original.reviewWorkspaceTarget!.machine,
          }),
        );
        locks.push(sources.materialization.lock);
      } else {
        const fleet = await loadFleetStatus(true);
        const allowed = original.dispatchRequest?.allowedSlots;
        const slots = fleet.slots.filter(
          (slot) =>
            slot.project === original.project &&
            (!original.slotId || original.slotId === slot.slot) &&
            (!allowed?.length || allowed.includes(slot.slot)) &&
            !slot.missingFromPool &&
            slot.lifecycle !== 'disabled' &&
            slot.lifecycle !== 'manual',
        );
        const plans = await planRunSourceSlots(original, slots, prepared);
        const candidate = [...(plans?.values() ?? [])].find((plan) => 'run' in plan);
        if (!candidate || !('run' in candidate))
          throw new SourceAdmissionRefusal(
            'The selected source closure has no valid run placement',
          );
        planned = candidate.run;
        locks.push(candidate.sources.materialization.lock);
      }
    } else {
      const contexts =
        params.scope === 'node'
          ? [{ nodeId: params.targetId }]
          : pools.length
            ? pools.map((pool) => ({ nodeId: pool.machine }))
            : [{}];
      for (const context of contexts)
        for (const project of resolver.affectedProjects(params.sourceId, context, prepared)) {
          const sources = await projectContext(project, context, prepared);
          locks.push(sources.materialization.lock);
        }
    }
    pools = await loadPoolConfigs();
    const result = await resolver.publishPins(prepared, locks, assertTarget, () => {
      if (planned) updateRun(planned.id, planned);
      return prepared.operation!.result;
    });
    if (planned) await persistRunNow(getRun(planned.id)!, 'source pin revalidation');
    return result;
  };
  return params.scope === 'run' ? withRunSourceMutation(params.targetId, execute) : execute();
}

export { SourcePlanRestart };

/** A fresh takeover replaces the process; only a nudge or warm handoff retains its inputs. */
export function retainedSourceOwner(
  run: Pick<Run, 'id' | 'parentRunId' | 'engineState'>,
  slotOwner: unknown,
): string | undefined {
  const flags = run.engineState?.flags;
  if (!flags?.warmSessionReuse && !flags?.nudgeReuse) return undefined;
  const owner = flags.warmSessionReuse ? run.parentRunId : slotOwner;
  if (typeof owner !== 'string' || !owner || owner === run.id)
    throw new SourceAdmissionRefusal('Retained source worker has no recorded prior owner');
  return owner;
}

/** Every step retains its run's generation; new main commits can never replace these inputs. */
export async function withRunSources<T>(
  run: Run,
  operation: () => Promise<T>,
  options: { planning?: boolean; nodeId?: string } = {},
): Promise<T> {
  const planningLock = run.sourcePlan?.lock ?? run.sourceProvenance?.lock;
  if (options.planning && planningLock) {
    if (!authority || !gateway) throw new SourceAdmissionRefusal('Source authority is unavailable');
    const materialization = await gateway.materialize(planningLock);
    return withProjectSources(
      {
        project: run.project,
        pack: planningLock.packBindings[run.project],
        materialization,
        packs: planningLock.packBindings,
      },
      operation,
    );
  }
  if (run.sourcePlan) {
    if (!authority || !gateway) throw new SourceAdmissionRefusal('Source authority is unavailable');
    const nodeId = options.nodeId ?? (await runNodeId(run));
    if (!nodeId) throw new SourceAdmissionRefusal('Source admission requires an execution node');
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await admitRunSources(run.id, { nodeId, ...(run.slotId ? { slotId: run.slotId } : {}) });
        return withRunSources(getRun(run.id)!, operation, { nodeId });
      } catch (error) {
        if (!(error instanceof SourcePlanRestart)) throw error;
      }
    }
    throw new SourceAdmissionRefusal('Source inputs kept changing before admission');
  }
  const provenance = run.sourceProvenance;
  if (!provenance) {
    if (authority && Date.parse(run.createdAt) >= Date.parse(authority.activatedAt()))
      throw new SourceAdmissionRefusal('New run has no admitted source lock');
    return withLegacyProjectSources(run.project, operation);
  }
  if (!authority || !gateway)
    throw new SourceAdmissionRefusal('Locked run cannot execute without the source authority');
  let materialization: SourceMaterialization;
  let execution: SourceMaterialization | undefined;
  let workerExecution: SourceMaterialization;
  let nodeId = options.nodeId ?? run.reviewWorkspaceTarget?.machine;
  try {
    if (sourceInputsDigest(provenance.lock) !== sourceInputsDigest(provenance.workerLock))
      throw new Error('Worker inputs do not match the admitted run lock');
    materialization = await gateway.materialize(provenance.lock);
    if (!options.nodeId && run.slotId) nodeId = (await resolveSlot(run.slotId)).pool.machine;
    execution = nodeId ? await nodeMaterialization(nodeId, provenance.lock) : undefined;
    workerExecution = nodeId
      ? await nodeMaterialization(nodeId, provenance.workerLock)
      : await gateway.materialize(provenance.workerLock);
  } catch (error) {
    throw new SourceAdmissionRefusal((error as Error).message, { cause: error });
  }
  if (
    execution &&
    (execution.lock.digest !== provenance.lock.digest ||
      execution.receipt.lockDigest !== provenance.lock.digest ||
      execution.receipt.nodeId !== nodeId)
  )
    throw new SourceAdmissionRefusal('Execution node attested a different source lock');
  const receiptIds = [
    ...new Set([
      ...provenance.receiptIds,
      materialization.receipt.id,
      ...(execution ? [execution.receipt.id] : []),
      workerExecution.receipt.id,
    ]),
  ];
  const attemptId = run.recoveryAttempts?.at(-1)?.id ?? `${run.id}:1`;
  const attempts = [...provenance.attempts];
  const existingAttempt = attempts.findIndex((attempt) => attempt.id === attemptId);
  const currentAttempt = {
    id: attemptId,
    receiptIds: [
      ...new Set([
        ...(attempts[existingAttempt]?.receiptIds ?? []),
        materialization.receipt.id,
        ...(execution ? [execution.receipt.id] : []),
        workerExecution.receipt.id,
      ]),
    ],
  };
  if (existingAttempt === -1) attempts.push(currentAttempt);
  else attempts[existingAttempt] = currentAttempt;
  if (receiptIds.length !== provenance.receiptIds.length || provenance.attemptId !== attemptId) {
    noteRunSourceWrite(
      updateRun(run.id, { sourceProvenance: { ...provenance, attemptId, attempts, receiptIds } }),
    );
  }
  return withProjectSources(
    {
      project: run.project,
      pack: provenance.bindings[0],
      materialization,
      execution,
      workerExecution,
      packs: provenance.lock.packBindings,
    },
    operation,
  );
}

/** A live retained process cannot adopt another run's changed or unknown source inputs. */
export function assertRetainedSourceInputs(
  prior: Pick<Run, 'sourceProvenance'> | null | undefined,
  next: Pick<Run, 'sourceProvenance'>,
): void {
  const before = prior?.sourceProvenance;
  const after = next.sourceProvenance;
  if (!before && !after) return;
  if (
    !before ||
    !after ||
    sourceInputsDigest(before.workerLock) !== sourceInputsDigest(after.workerLock)
  )
    throw new SourceAdmissionRefusal('Retained worker source inputs changed or are unknown');
}

export async function verifyExecutionSources(
  nodeId: string,
  materialization: SourceMaterialization,
): Promise<void> {
  try {
    if (materialization.receipt.nodeId === 'gateway') {
      if (!gateway) throw new Error('Gateway source authority is unavailable');
      await gateway.verify(materialization.lock);
      return;
    }
    if (materialization.receipt.nodeId !== nodeId)
      throw new Error('Source execution ownership changed');
    const node = await waitForNode(nodeId, 0);
    assertNodeReconnectCurrent();
    await sendNodeRequest(
      node,
      'sources.verify',
      { lock: materialization.lock },
      { timeout: 30_000, requireSameConnection: true },
    );
  } catch (error) {
    throw new SourceAdmissionRefusal((error as Error).message, { cause: error });
  }
}

/** Slot actions share admission with runs; the target node attests before hooks expand. */
export async function withSlotSources<T>(slotId: string, operation: () => Promise<T>): Promise<T> {
  if (!authority) return operation();
  const { slot, pool } = await resolveSlot(slotId);
  const project = slot.project ?? pool.project;
  const { readSlotField } = await import('../core/state.js');
  const currentRunId = await readSlotField(slotId, 'current_run_id');
  const owner = typeof currentRunId === 'string' ? getRun(currentRunId) : undefined;
  if (owner?.slotId === slotId) return withRunSources(owner, operation);
  const current = currentProjectSources();
  if (current?.project === project && current.execution?.receipt.nodeId === pool.machine)
    return operation();
  const sources =
    current?.project === project && current.materialization.lock.context.nodeId === pool.machine
      ? current
      : await projectContext(project, { nodeId: pool.machine });
  const execution = await nodeMaterialization(pool.machine, sources.materialization.lock);
  if (
    execution.receipt.nodeId !== pool.machine ||
    execution.receipt.lockDigest !== sources.materialization.lock.digest
  )
    throw new SourceAdmissionRefusal('Slot node attested a different source lock');
  return withProjectSources({ ...sources, execution }, operation);
}
