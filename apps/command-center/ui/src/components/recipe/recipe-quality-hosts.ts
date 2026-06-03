import type {
  EvidenceQualityReport,
  LiveRecipeContext,
  ReadyGatePayload,
  RecipeQualityArtifact,
  RecipeRunArtifactGroup,
  ReviewGatePayload,
  Run,
  RunDecision,
} from '@farmslot/protocol';
import { hasLiveRecipeEvidence } from '@farmslot/protocol';

type RecipeDecisionPayload = ReviewGatePayload | ReadyGatePayload;

export interface RecipeHostCapabilities {
  canRerun: boolean;
  canCancel: boolean;
}

export interface RecipeHostOutputTarget {
  runId: string;
  slotId: string;
}

export interface RecipeHostEntry {
  runId: string;
  slotId: string | null;
  branch: string | null;
  recipeJson: string | null;
  recipeQualityArtifact: RecipeQualityArtifact | null;
  qualityReport: EvidenceQualityReport | null;
  workerLearnings: string | null;
  outputTarget: RecipeHostOutputTarget | null;
  artifactManifest: LiveRecipeContext['artifactManifest'];
  capabilities: RecipeHostCapabilities;
  provenanceLabel: string;
  provenanceDetail: string | null;
  provenanceSource: LiveRecipeContext['source'] | 'decision';
  emptyRecipeMessage: string | null;
}

export interface SlotViewRecipeHostEntry extends RecipeHostEntry {
  decisionKind: RecipeDecisionPayload['kind'] | null;
  isPending: boolean;
}

function isRecipeDecisionPayload(
  payload: RunDecision['payload'] | undefined,
): payload is RecipeDecisionPayload {
  return payload?.kind === 'review' || payload?.kind === 'ready';
}

function payloadHasRecipeContext(payload: RecipeDecisionPayload): boolean {
  return Boolean(
    payload.recipeJson ||
    payload.recipeQualityArtifact ||
    ('qualityReport' in payload && payload.qualityReport) ||
    payload.workerLearnings,
  );
}

function toRecipeHostEntry(
  runId: string,
  slotId: string | null,
  branch: string | null,
  payload: RecipeDecisionPayload,
  capabilities: RecipeHostCapabilities,
): RecipeHostEntry {
  return {
    runId,
    slotId,
    branch,
    recipeJson: payload.recipeJson ?? null,
    recipeQualityArtifact: payload.recipeQualityArtifact ?? null,
    qualityReport: 'qualityReport' in payload ? (payload.qualityReport ?? null) : null,
    workerLearnings: payload.workerLearnings ?? null,
    outputTarget: capabilities.canRerun && slotId ? { runId, slotId } : null,
    artifactManifest: null,
    capabilities,
    provenanceLabel: 'Decision',
    provenanceDetail: null,
    provenanceSource: 'decision',
    emptyRecipeMessage: null,
  };
}

function formatLiveRecipeProvenanceLabel(context: LiveRecipeContext): string {
  const groupContext = context as LiveRecipeContext & Partial<RecipeRunArtifactGroup>;
  if (groupContext.groupKind === 'current-artifacts') return 'Recipe package';
  if (groupContext.groupKind === 'latest-valid') return 'Latest passing evidence';
  if (groupContext.groupKind === 'live-run') return 'Attempted run';
  switch (context.source) {
    case 'recipe-run-live':
      return 'Recipe run';
    case 'recipe-run-artifacts':
      return 'Recipe artifacts';
    case 'final-artifacts':
      return 'Final artifacts';
    case 'decision':
    default:
      return 'Decision';
  }
}

function formatLiveRecipeProvenanceDetail(context: LiveRecipeContext): string | null {
  const groupContext = context as LiveRecipeContext & Partial<RecipeRunArtifactGroup>;
  if (groupContext.groupKind === 'latest-valid' && context.recipeRunId)
    return `promoted:${context.recipeRunId}`;
  if (groupContext.groupKind === 'live-run' && context.recipeRunId)
    return `not-promoted:${context.recipeRunId}`;
  if (groupContext.groupKind === 'current-artifacts') return 'root bundle';
  if (context.recipeRunId) return `run:${context.recipeRunId}`;
  if (context.artifactRoot) return context.artifactRoot;
  return null;
}

function toLiveRecipeHostEntry(
  run: Run,
  slotId: string,
  context: LiveRecipeContext,
): SlotViewRecipeHostEntry {
  const groupContext = context as LiveRecipeContext & Partial<RecipeRunArtifactGroup>;
  const canRerun = groupContext.groupKind === 'current-artifacts' && Boolean(slotId);
  return {
    runId: run.id,
    slotId: slotId || null,
    branch: run.branch ?? null,
    recipeJson: context.recipeJson,
    recipeQualityArtifact: context.recipeQualityArtifact,
    qualityReport: context.qualityReport,
    workerLearnings: context.workerLearnings,
    outputTarget: canRerun && slotId ? { runId: run.id, slotId } : null,
    artifactManifest: context.artifactManifest ?? null,
    capabilities: {
      canRerun,
      canCancel: false,
    },
    provenanceLabel: formatLiveRecipeProvenanceLabel(context),
    provenanceDetail: formatLiveRecipeProvenanceDetail(context),
    provenanceSource: context.source,
    emptyRecipeMessage: context.isStale
      ? 'Selected recipe run could not be materialized from its artifact root.'
      : null,
    decisionKind: null,
    isPending: false,
  };
}

export function createReviewWorkspaceRecipeHostEntry(args: {
  runId: string;
  slotId: string;
  branch: string | null;
  payload: ReviewGatePayload;
}): RecipeHostEntry {
  return toRecipeHostEntry(args.runId, args.slotId || null, args.branch, args.payload, {
    canRerun: Boolean(args.payload.recipeJson && args.slotId),
    canCancel: Boolean(args.payload.recipeJson && args.slotId),
  });
}

export function createFamilyObservabilityRecipeHostEntry(args: {
  runId: string;
  slotId: string | null;
  branch: string | null;
  recipeJson: string | null;
  recipeQualityArtifact: RecipeQualityArtifact | null;
  workerLearnings: string | null;
  canRerun: boolean;
}): RecipeHostEntry {
  return {
    runId: args.runId,
    slotId: args.slotId,
    branch: args.branch,
    recipeJson: args.recipeJson,
    recipeQualityArtifact: args.recipeQualityArtifact,
    qualityReport: null,
    workerLearnings: args.workerLearnings,
    outputTarget: args.canRerun && args.slotId ? { runId: args.runId, slotId: args.slotId } : null,
    artifactManifest: null,
    capabilities: {
      canRerun: args.canRerun,
      canCancel: false,
    },
    provenanceLabel: 'Final artifacts',
    provenanceDetail: args.runId ? `run:${args.runId}` : null,
    provenanceSource: 'final-artifacts',
    emptyRecipeMessage: null,
  };
}

function findSlotViewRecipeDecision(
  run: Run,
): { payload: RecipeDecisionPayload; isPending: boolean } | null {
  for (const decision of run.decisions) {
    if (!isRecipeDecisionPayload(decision.payload) || !payloadHasRecipeContext(decision.payload))
      continue;
    if (!decision.resolvedAt) return { payload: decision.payload, isPending: true };
  }

  for (let index = run.decisions.length - 1; index >= 0; index -= 1) {
    const decision = run.decisions[index];
    if (!isRecipeDecisionPayload(decision.payload) || !payloadHasRecipeContext(decision.payload))
      continue;
    return { payload: decision.payload, isPending: false };
  }

  return null;
}

export function createSlotViewRecipeHostEntry(
  run: Run | null,
  slotId: string,
  preferredContext: LiveRecipeContext | null = null,
): SlotViewRecipeHostEntry | null {
  if (!run) return null;
  const liveRecipeContext = preferredContext ?? run.liveRecipeContext;
  if (
    liveRecipeContext &&
    (liveRecipeContext.isStale || hasLiveRecipeEvidence(liveRecipeContext))
  ) {
    return toLiveRecipeHostEntry(run, slotId, {
      ...liveRecipeContext,
      recipeJson: liveRecipeContext.recipeJson ?? null,
      recipeQualityArtifact: liveRecipeContext.recipeQualityArtifact ?? null,
      workerLearnings: liveRecipeContext.workerLearnings ?? null,
    });
  }

  const recipeDecision = findSlotViewRecipeDecision(run);
  if (!recipeDecision) return null;

  const capabilities: RecipeHostCapabilities = {
    canRerun:
      recipeDecision.payload.kind === 'review' &&
      Boolean(recipeDecision.payload.recipeJson && slotId),
    canCancel:
      recipeDecision.payload.kind === 'review' &&
      Boolean(recipeDecision.payload.recipeJson && slotId),
  };

  return {
    ...toRecipeHostEntry(
      run.id,
      slotId || null,
      run.branch ?? null,
      recipeDecision.payload,
      capabilities,
    ),
    decisionKind: recipeDecision.payload.kind,
    isPending: recipeDecision.isPending,
  };
}
