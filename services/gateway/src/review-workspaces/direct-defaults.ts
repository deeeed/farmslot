import {
  assertPRExecutionProfile,
  type FlowType,
  isPRWorkspaceExecutionProfile,
  parseNativeProfileReference,
  prExecutionChoices,
  type PRExecutionProfile,
  type ProjectConfig,
  type PRWorkflowDefaultSources,
  type PRWorkspaceExecutionChoice,
  resolvePRWorkflowDefaults,
  resolveReviewQaDispatch,
  type ReviewQaDispatchInput,
  type ReviewQaDispatchSelection,
  type RunCreateParams,
  sameNativeProfileReference,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import {
  isNodeTransportUnavailableError,
  type NodeTransportUnavailableError,
} from '../fleet/node-rpc.js';
import { loadFleetStatus, loadPoolConfigs } from '../fleet/state.js';
import { isFreeSlot } from '../methods/dispatch/slot-scoring.js';
import { isKnownRunner, runnerSupportsEffort, runnerSupportsModel } from '../runners/registry.js';

import {
  assertReviewWorkspaceAdmitted,
  assertReviewWorkspacePlacement,
  inspectReviewWorkspaceTarget,
  type ReviewWorkspaceAdmission,
} from './admission.js';

export type DirectWorkflowRequest = ReviewQaDispatchInput &
  Pick<
    RunCreateParams,
    | 'reviewValidationDepth'
    | 'project'
    | 'domain'
    | 'runner'
    | 'model'
    | 'effort'
    | 'transport'
    | 'nativeProfile'
    | 'reviewWorkspaceTarget'
    | 'slotId'
    | 'allowedSlots'
    | 'reviewScope'
    | 'mode'
    | 'executionTemplateId'
    | 'taskTemplate'
    | 'completionPolicy'
  > & { flowType: FlowType };

export interface DirectWorkflowDefaultsResult<T> {
  params: T;
  reviewQa?: ReviewQaDispatchSelection;
  execution?: PRExecutionProfile;
  sources?: PRWorkflowDefaultSources;
  admission?: ReviewWorkspaceAdmission;
}

function unavailable(message: string): never {
  throw new GatewayMethodError('REVIEW_WORKSPACE_NEEDS_CONFIGURATION', message);
}

/** Flat selections narrow the declared policy; no target/model restriction is discarded. */
export function constrainDirectWorkflowExecution(
  profile: PRExecutionProfile,
  input: DirectWorkflowRequest,
): PRExecutionProfile {
  assertPRExecutionProfile(profile);
  const selected = structuredClone(profile);
  const nativeProfile =
    input.nativeProfile === undefined
      ? undefined
      : parseNativeProfileReference(input.nativeProfile);
  const runner = input.runner ?? nativeProfile?.runner;
  selected.models = selected.models.filter(
    (model) =>
      (runner === undefined || model.runner === runner) &&
      (input.model === undefined || model.model === input.model) &&
      (input.effort === undefined || model.effort === input.effort),
  );
  if (isPRWorkspaceExecutionProfile(selected)) {
    if (input.slotId || input.allowedSlots?.length)
      unavailable(
        'Select an authorized review machine; legacy slot placement requires explicit migration',
      );
    const allowed =
      selected.workspacePolicy.kind === 'exact'
        ? [selected.workspacePolicy.machine]
        : selected.workspacePolicy.allowedMachines;
    if (input.reviewWorkspaceTarget) {
      const machine = input.reviewWorkspaceTarget.machine;
      if (!allowed.includes(machine))
        unavailable('Selected machine is outside the declared workflow execution policy');
      selected.workspacePolicy = { kind: 'exact', machine };
      selected.models = selected.models
        .filter((model) => !model.allowedMachines || model.allowedMachines.includes(machine))
        .map((model) => ({
          ...model,
          ...(model.allowedMachines ? { allowedMachines: [machine] } : {}),
        }));
    }
    if (
      input.transport !== undefined &&
      selected.transport !== undefined &&
      input.transport !== selected.transport
    )
      unavailable('Selected transport conflicts with the declared workflow execution policy');
    if (input.transport !== undefined) selected.transport = input.transport;
    if (nativeProfile) {
      if (
        selected.nativeProfile &&
        !sameNativeProfileReference(selected.nativeProfile, nativeProfile)
      )
        unavailable(
          'Selected native profile conflicts with the declared workflow execution policy',
        );
      selected.nativeProfile = nativeProfile;
    }
  } else {
    if (input.reviewWorkspaceTarget)
      unavailable('QA requires runtime slots, not a review workspace');
    const allowed =
      selected.slotPolicy.kind === 'exact'
        ? [selected.slotPolicy.slotId]
        : selected.slotPolicy.allowedSlots;
    const restricted = allowed.filter(
      (slot) =>
        (!input.slotId || slot === input.slotId) &&
        (!input.allowedSlots?.length || input.allowedSlots.includes(slot)),
    );
    if (!restricted.length)
      unavailable('Selected slots are outside the declared workflow execution policy');
    selected.slotPolicy =
      input.slotId || selected.slotPolicy.kind === 'exact'
        ? { kind: 'exact', slotId: restricted[0] }
        : { kind: 'pool', allowedSlots: restricted };
    selected.models = selected.models.flatMap((model) => {
      if (!model.allowedSlots) return [model];
      const slots = model.allowedSlots.filter((slot) => restricted.includes(slot));
      return slots.length ? [{ ...model, allowedSlots: slots }] : [];
    });
  }
  if (!selected.models.length)
    unavailable('Selected runner/model/effort has no allowed execution choice');
  assertPRExecutionProfile(selected);
  return selected;
}

/** Apply farm defaults before legacy normalization, then choose through shared admission. */
export async function resolveDirectWorkflowDefaults<T extends DirectWorkflowRequest>(
  original: T,
  project: Pick<ProjectConfig, 'workflowDefaults' | 'qa' | 'staticReview'> | null | undefined,
  options: {
    purpose: 'preview' | 'queue' | 'run';
    ownerId?: string;
    execution?: PRExecutionProfile;
  },
): Promise<DirectWorkflowDefaultsResult<T & DirectWorkflowRequest>> {
  if (original.flowType !== 'review-pr' && original.flowType !== 'qa') {
    resolveReviewQaDispatch(original, project?.qa);
    assertReviewWorkspacePlacement(original);
    return { params: original };
  }
  const flow =
    original.flowType === 'qa' || original.reviewValidationDepth === 'full-live'
      ? 'qa'
      : 'review-pr';
  if (flow === 'review-pr') {
    if (original.taskTemplate)
      unavailable('Workspace review requires the configured static-review catalog template');
    if (
      original.executionTemplateId &&
      original.executionTemplateId !== project?.staticReview?.templateId
    )
      unavailable('Select the configured static-review template');
  }
  if (original.reviewWorkspaceTarget) assertReviewWorkspacePlacement(original);
  const defaults = resolvePRWorkflowDefaults({ workflow: flow, farm: project?.workflowDefaults });
  let params = {
    ...original,
    mode: original.mode ?? ('autonomous' as const),
    reviewScope: original.reviewScope ?? defaults.review.scope,
    ...(flow === 'review-pr' && original.domain === undefined && project?.staticReview?.domain
      ? { domain: project.staticReview.domain }
      : {}),
  };
  if (flow === 'qa') {
    params = {
      ...params,
      qaProfileId: original.qaProfileId ?? defaults.review.qaProfileId,
      qaInputs: { ...defaults.review.qaInputs, ...original.qaInputs },
    };
  }
  const reviewQa = resolveReviewQaDispatch(params, project?.qa);
  if (reviewQa) {
    params = {
      ...params,
      flowType: reviewQa.flowType,
      reviewTier: undefined,
      reviewValidationDepth: undefined,
    };
    if (reviewQa.qa)
      params = {
        ...params,
        taskTemplate: undefined,
        executionTemplateId: reviewQa.qa.profile.template_id,
        qaProfileId: reviewQa.qa.profile.id,
        qaInputs: reviewQa.qa.inputs,
        completionPolicy: 'artifact-only',
      };
  }
  if (flow === 'review-pr' && (params.slotId || params.allowedSlots?.length))
    unavailable(
      'Select an authorized review machine; legacy slot placement requires explicit migration',
    );
  let profile = options.execution ?? defaults.execution;
  if (
    !profile &&
    flow === 'review-pr' &&
    params.reviewWorkspaceTarget &&
    params.runner &&
    params.model
  ) {
    profile = {
      workspacePolicy: { kind: 'exact', machine: params.reviewWorkspaceTarget.machine },
      models: [{ runner: params.runner, model: params.model, effort: params.effort }],
      transport: params.transport,
      nativeProfile: params.nativeProfile,
    };
  }
  if (!profile) return { params: params as T, reviewQa, sources: defaults.sources };
  if (isPRWorkspaceExecutionProfile(profile) !== (flow === 'review-pr'))
    unavailable('Workflow execution policy uses the wrong resource type');
  const execution = constrainDirectWorkflowExecution(profile, params);
  if (isPRWorkspaceExecutionProfile(execution)) {
    if (!options.ownerId)
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Workspace review requires an authenticated execution owner',
      );
    let waiting:
      | {
          choice: PRWorkspaceExecutionChoice;
          admission: ReviewWorkspaceAdmission;
        }
      | undefined;
    let reason: GatewayMethodError | NodeTransportUnavailableError | undefined;
    let waitingReason: GatewayMethodError | undefined;
    for (const choice of prExecutionChoices(execution)) {
      let admission: ReviewWorkspaceAdmission | undefined;
      try {
        admission = await inspectReviewWorkspaceTarget(
          { project: params.project, ...choice },
          options.ownerId,
        );
        waiting ??= { choice, admission };
        assertReviewWorkspaceAdmitted(admission);
        waiting = { choice, admission };
        reason = undefined;
        waitingReason = undefined;
        break;
      } catch (error) {
        if (!(error instanceof GatewayMethodError) && !isNodeTransportUnavailableError(error))
          throw error;
        if (admission && error instanceof GatewayMethodError) waitingReason ??= error;
        reason = error;
      }
    }
    if (!waiting || (options.purpose === 'run' && (waitingReason ?? reason)))
      throw (
        waitingReason ??
        reason ??
        new GatewayMethodError('REVIEW_WORKSPACE_NEEDS_CONFIGURATION', 'No eligible review machine')
      );
    const choice = waiting.choice;
    params = {
      ...params,
      reviewWorkspaceTarget: { machine: choice.machine },
      runner: choice.runner,
      model: choice.model,
      effort: choice.effort,
      transport: choice.transport,
      nativeProfile: choice.nativeProfile,
    };
    assertReviewWorkspacePlacement(params);
    return {
      params: params as T,
      reviewQa,
      execution,
      sources: defaults.sources,
      admission: waiting.admission,
    };
  }
  const [fleet, pools] = await Promise.all([loadFleetStatus(), loadPoolConfigs()]);
  const choices = prExecutionChoices(execution).filter((choice) =>
    pools.some((pool) =>
      pool.slots.some(
        (slot) => slot.id === choice.slotId && (slot.project ?? pool.project) === params.project,
      ),
    ),
  );
  const choice =
    choices.find((candidate) =>
      fleet.slots.some((slot) => slot.slot === candidate.slotId && isFreeSlot(slot)),
    ) ?? choices[0];
  if (!choice) unavailable('No configured runtime slot matches the workflow execution policy');
  if (
    !isKnownRunner(choice.runner) ||
    !runnerSupportsModel(choice.runner, choice.model) ||
    !runnerSupportsEffort(choice.runner, choice.model, choice.effort)
  )
    unavailable('Selected runner/model/effort is unsupported');
  params = {
    ...params,
    slotId: options.purpose !== 'queue' || params.slotId ? choice.slotId : undefined,
    allowedSlots: choices
      .filter(
        (candidate) =>
          candidate.runner === choice.runner &&
          candidate.model === choice.model &&
          candidate.effort === choice.effort,
      )
      .map((candidate) => candidate.slotId),
    runner: choice.runner,
    model: choice.model,
    effort: choice.effort,
  };
  return { params: params as T, reviewQa, execution, sources: defaults.sources };
}
