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
import { reviewValidationDepthForLoop } from '@farmslot/protocol';

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
  return options.find(
    (option) => option.variant === 'interactive' || /-interactive\.md$/.test(option.fileName),
  );
}

export function projectApps(
  configs: ReadonlyArray<{ name: string; apps?: string[] }>,
  projectName: string,
): string[] {
  return configs.find((project) => project.name === projectName)?.apps ?? [];
}

export interface PrepareProfileOption {
  name: string;
  label: string;
  isDefault: boolean;
}

export function projectPrepareProfiles(
  configs: ReadonlyArray<{ name: string; prepare?: import('@farmslot/protocol').ProjectPrepareConfig }>,
  projectName: string,
): PrepareProfileOption[] {
  const prepare = configs.find((project) => project.name === projectName)?.prepare;
  if (!prepare) return [];
  // Mirrors gateway resolvePrepareProfile: prepare.default, else a profile
  // literally named "full" is the implicit default.
  const defaultName = prepare.default ?? ('full' in prepare.profiles ? 'full' : '');
  return Object.entries(prepare.profiles).map(([name, profile]) => ({
    name,
    label: profile.label || name,
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

export function modeForFlow(flowType: FlowType): 'interactive' | 'autonomous' {
  if (flowType === 'pr-complete') return 'autonomous';
  return flowType === 'fix-bug' ? 'autonomous' : 'interactive';
}

export function selectedTemplateMode(
  flowType: FlowType | null,
  options: ReadonlyArray<WorkerTemplateOption>,
  selectedFileName: string,
): 'interactive' | 'autonomous' {
  if (!flowType) return 'interactive';
  const selected = options.find((option) => option.fileName === selectedFileName);
  if (selected?.variant === 'interactive' || /-interactive\.md$/.test(selected?.fileName ?? '')) {
    return 'interactive';
  }
  if (selected?.isDefault && interactiveTemplateOption(options)) return 'autonomous';
  return modeForFlow(flowType);
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
  return {
    minimumIndependentReviews: 1,
    extraLoopsRequested: plan.length,
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
