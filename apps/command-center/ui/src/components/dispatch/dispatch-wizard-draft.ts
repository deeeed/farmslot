import type {
  DevInteractiveProfile,
  FlowType,
  ReviewDepthPolicy,
  ReviewLoopRequest,
  ReviewRunnerId,
  ReviewValidationDepth,
  TaskTemplateSelection,
  WorkerTemplateOption,
} from '@farmslot/protocol';
import {
  interactiveWorkerTemplateOption,
  modeForFlow,
  reviewValidationDepthForLoop,
  selectedTemplateMode,
} from '@farmslot/protocol';

import type { EffortLevel } from '../../utils/runner-options.js';

export interface PublicationReviewLoopDraft {
  id: number;
  runner: ReviewRunnerId;
  validationDepth?: ReviewValidationDepth;
}

export interface DispatchDraftState {
  flowType: FlowType | null;
  ticketId: string;
  project: string;
  model: string;
  runner: string;
  effort: EffortLevel;
  mode: 'interactive' | 'autonomous';
  devInteractiveProfile: DevInteractiveProfile;
  reviewTier: '' | 'light' | 'standard' | 'full';
  skipPrepare: boolean;
  publicationReviewLoops: PublicationReviewLoopDraft[];
}

export function selectedTaskTemplate(
  options: ReadonlyArray<WorkerTemplateOption>,
  selectedFileName: string,
): TaskTemplateSelection | undefined {
  const selected = options.find((option) => option.fileName === selectedFileName);
  if (!selected || selected.isDefault) return undefined;
  return { fileName: selected.fileName, variant: selected.variant ?? null };
}

export function interactiveTemplateOption(
  options: ReadonlyArray<WorkerTemplateOption>,
): WorkerTemplateOption | undefined {
  return interactiveWorkerTemplateOption(options);
}

export { modeForFlow, selectedTemplateMode };

export function projectApps(
  configs: ReadonlyArray<{ name: string; apps?: string[] }>,
  projectName: string,
): string[] {
  return configs.find((project) => project.name === projectName)?.apps ?? [];
}

export interface PrepareProfileOption {
  name: string;
  label: string;
  description?: string;
  isDefault: boolean;
}

export function projectPrepareProfiles(
  configs: ReadonlyArray<{
    name: string;
    prepare?: import('@farmslot/protocol').ProjectPrepareConfig;
  }>,
  projectName: string,
): PrepareProfileOption[] {
  const prepare = configs.find((project) => project.name === projectName)?.prepare;
  if (!prepare) return [];
  const profiles = prepare.profiles ?? {};
  // Mirrors gateway resolvePrepareProfile: core wins for implicit selection;
  // legacy projects retain prepare.default / "full" fallback behavior.
  const defaultName = prepare.core
    ? 'core'
    : (prepare.default ?? ('full' in profiles ? 'full' : ''));
  const entries = [
    ...(prepare.core ? ([['core', prepare.core]] as const) : []),
    ...Object.entries(profiles),
  ];
  return entries.map(([name, profile]) => ({
    name,
    label: profile.label || name,
    ...(profile.description ? { description: profile.description } : {}),
    isDefault: name === defaultName,
  }));
}

export function syncSelectedAppForProject(apps: ReadonlyArray<string>, currentApp: string): string {
  if (apps.length <= 1) return '';
  return apps.includes(currentApp) ? currentApp : (apps[0] ?? '');
}

export function selectedDispatchApp(
  apps: ReadonlyArray<string>,
  currentApp: string,
): string | undefined {
  if (apps.length <= 1) return undefined;
  return currentApp || apps[0];
}

export function appLabel(app: string): string {
  const parts = app.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? app) : app;
}

export function defaultExtraReviewRunner(
  currentRunner: string,
  runnerOptions: ReadonlyArray<ReviewRunnerId>,
): ReviewRunnerId {
  const current = runnerOptions.includes(currentRunner as ReviewRunnerId)
    ? (currentRunner as ReviewRunnerId)
    : 'claude';
  return runnerOptions.find((runner) => runner !== current) ?? current;
}

export function publicationReviewsEnabled(
  flowType: FlowType | null,
  mode?: 'interactive' | 'autonomous',
): boolean {
  if (flowType === 'fix-bug') return true;
  return flowType === 'dev' && mode === 'autonomous';
}

export function buildPublicationReviewPlan(
  flowType: FlowType | null,
  currentRunner: string,
  loops: ReadonlyArray<PublicationReviewLoopDraft>,
  runnerOptions: ReadonlyArray<ReviewRunnerId>,
  mode?: 'interactive' | 'autonomous',
): ReviewLoopRequest[] {
  if (!publicationReviewsEnabled(flowType, mode)) return [];
  const current = runnerOptions.includes(currentRunner as ReviewRunnerId)
    ? (currentRunner as ReviewRunnerId)
    : 'claude';
  return loops.slice(0, 5).map((loop, index) => ({
    order: index + 1,
    runner: loop.runner || current,
    validationDepth: loop.validationDepth ?? reviewValidationDepthForLoop(index, loops.length),
  }));
}

export function buildPublicationReviewDepth(
  flowType: FlowType | null,
  currentRunner: string,
  plan: ReadonlyArray<ReviewLoopRequest>,
  mode?: 'interactive' | 'autonomous',
): ReviewDepthPolicy | undefined {
  if (!publicationReviewsEnabled(flowType, mode) || plan.length === 0) return undefined;
  return reviewDepthForConfiguredPlan(currentRunner, plan);
}

export function reviewDepthForConfiguredPlan(
  currentRunner: string,
  plan: ReadonlyArray<ReviewLoopRequest>,
): ReviewDepthPolicy {
  return {
    minimumIndependentReviews: 1,
    // The first configured loop satisfies the publication minimum. Only
    // later loops are additional requirements.
    extraLoopsRequested: Math.max(0, plan.length - 1),
    countingVersion: 2,
    requireCrossRunner: plan.some((loop) => loop.runner !== currentRunner),
    requestedBy: 'dispatch',
  };
}

export function buildPublicationReviewGateParams(
  flowType: FlowType | null,
  currentRunner: string,
  loops: ReadonlyArray<PublicationReviewLoopDraft>,
  runnerOptions: ReadonlyArray<ReviewRunnerId>,
  mode?: 'interactive' | 'autonomous',
): { reviewDepth?: ReviewDepthPolicy; pendingReviewPlan?: ReviewLoopRequest[] } {
  const pendingReviewPlan = buildPublicationReviewPlan(
    flowType,
    currentRunner,
    loops,
    runnerOptions,
    mode,
  );
  const reviewDepth = buildPublicationReviewDepth(flowType, currentRunner, pendingReviewPlan, mode);
  return reviewDepth ? { reviewDepth, pendingReviewPlan } : {};
}
