import type {
  EvalExperimentCreateResult,
  EvalExperimentSource,
  EvalPackageAxes,
  EvalTaskProfile,
  EvalTrialStartResult,
  QueueItem,
  ResultPackageManifest,
  ResultPackageProjection,
  Run,
  WorkerTemplateOption,
} from '@farmslot/protocol';
import { isTerminalRunStatus } from '@farmslot/protocol';

import {
  DEFAULT_MODEL,
  EVAL_CANDIDATE_RUNNERS,
  MODELS_BY_RUNNER,
  runnerLabel,
} from '../../utils/runner-options.js';

import type { CandidateRow, EvalReviewMode } from './eval-cockpit-url-state.js';
import {
  datasetIdFor,
  type EvalSelectedCase,
  generatedCandidateVariant,
  stableIdHash,
} from './eval-suite-helpers.js';
import type { EvalLaunchCell } from './eval-suite-launch-model.js';

export type PackageRow = ResultPackageProjection & { rowOrigin: 'manifest' | 'result' };

export interface CandidateTemplateChoice {
  path: string;
  label: string;
  description: string;
  promptName: EvalTaskProfile;
}

export const DEFAULT_CANDIDATE_ROW_COUNT = 1;
export const FAILED_RUN_STATUSES = new Set(['failed', 'cancelled']);
export const DEFAULT_EVAL_CANDIDATE_RUNNER = EVAL_CANDIDATE_RUNNERS[0] ?? '';
export const DEFAULT_EVAL_REVIEW_MODE: EvalReviewMode = 'none';
export const EVAL_REVIEW_MODE_OPTIONS: ReadonlyArray<{
  mode: EvalReviewMode;
  label: string;
  description: string;
}> = [
  {
    mode: 'none',
    label: 'First pass only',
    description: 'Skip the post-fix review loop; useful for replay and harness checks.',
  },
  {
    mode: 'default',
    label: 'Default review loop',
    description: 'Run the normal Farmslot self-review behavior after the worker pass.',
  },
  {
    mode: 'custom',
    label: 'Custom review axis',
    description: 'Tag this candidate for a named review strategy or external loop.',
  },
];
export const CANDIDATE_TEMPLATE_OPTIONS: readonly CandidateTemplateChoice[] = [
  {
    path: 'templates/worker/fix-bug.md',
    label: 'Bug fix template',
    description: 'Use the project worker template for fixing a known bug.',
    promptName: 'fix-bug',
  },
  {
    path: 'templates/worker/dev.md',
    label: 'Dev template',
    description: 'Use the project worker template for implementing a feature/dev task.',
    promptName: 'dev',
  },
];

export function activeEvalRunCount(runs: readonly Run[], capGroupId: string): number {
  return runs.filter(
    (run) =>
      run.engineState?.evalExperiment?.capGroupId === capGroupId &&
      !isTerminalRunStatus(run.status),
  ).length;
}

export function queuedEvalItemsForCapGroup(
  queueItems: readonly QueueItem[],
  capGroupId: string,
): QueueItem[] {
  return queueItems.filter((item) => item.evalCell?.capGroupId === capGroupId);
}

export function manualEvalProjectValue(params: {
  manualProject: string;
  currentProject: string;
  catalogProjects: readonly string[];
  fallback?: string;
}): string {
  return (
    params.manualProject.trim() ||
    params.currentProject.trim() ||
    params.catalogProjects[0] ||
    params.fallback ||
    'project'
  );
}

export function manualEvalProjectOptions(params: {
  manualProjectValue: string;
  currentProject: string;
  catalogProjects: readonly string[];
  selectedProjects: readonly string[];
}): string[] {
  return [
    ...new Set(
      [
        params.manualProjectValue,
        params.currentProject.trim(),
        ...params.catalogProjects,
        ...params.selectedProjects,
      ].filter(Boolean),
    ),
  ].sort();
}

export function candidateTemplateForTaskProfile(
  taskProfile: EvalTaskProfile,
): CandidateTemplateChoice {
  return (
    CANDIDATE_TEMPLATE_OPTIONS.find((entry) => entry.promptName === taskProfile) ??
    CANDIDATE_TEMPLATE_OPTIONS[0]
  );
}

export function defaultRows(): CandidateRow[] {
  const rows: CandidateRow[] = [
    {
      id: 'replay-candidate',
      enabled: true,
      label: '',
      templatePath: 'templates/worker/fix-bug.md',
      templateHash: '',
      promptName: 'fix-bug',
      promptHash: '',
      harnessRef: 'current',
      baseRecipePath: '',
      baseRecipeHash: '',
      reviewMode: DEFAULT_EVAL_REVIEW_MODE,
      reviewName: '',
      reviewVersion: '',
      runner: DEFAULT_EVAL_CANDIDATE_RUNNER,
      model: DEFAULT_MODEL[DEFAULT_EVAL_CANDIDATE_RUNNER] ?? DEFAULT_MODEL.codex,
      repeat: false,
    },
  ];
  return rows.slice(0, DEFAULT_CANDIDATE_ROW_COUNT);
}

export function sanitizeCandidateRows(rows: unknown): CandidateRow[] {
  if (!Array.isArray(rows)) return defaultRows();
  const fallback = defaultRows()[0];
  const sanitized = rows.flatMap((raw, index): CandidateRow[] => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Partial<Record<keyof CandidateRow, unknown>>;
    const id =
      typeof record.id === 'string' && record.id.trim() ? record.id : `candidate-${index + 1}`;
    const runner =
      typeof record.runner === 'string' &&
      EVAL_CANDIDATE_RUNNERS.includes(record.runner as (typeof EVAL_CANDIDATE_RUNNERS)[number])
        ? record.runner
        : fallback.runner;
    const model =
      typeof record.model === 'string' && candidateModelOptions(runner).includes(record.model)
        ? record.model
        : (candidateModelOptions(runner)[0] ?? fallback.model);
    const rawLabel = typeof record.label === 'string' ? record.label.trim() : '';
    const label = rawLabel === 'Replay candidate' || rawLabel === id ? '' : rawLabel;
    const reviewMode =
      record.reviewMode === 'none' ||
      record.reviewMode === 'default' ||
      record.reviewMode === 'custom'
        ? record.reviewMode
        : DEFAULT_EVAL_REVIEW_MODE;
    return [
      {
        ...fallback,
        id,
        enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
        label,
        templatePath:
          typeof record.templatePath === 'string' ? record.templatePath : fallback.templatePath,
        templateHash: typeof record.templateHash === 'string' ? record.templateHash : '',
        promptName: typeof record.promptName === 'string' ? record.promptName : fallback.promptName,
        promptHash: typeof record.promptHash === 'string' ? record.promptHash : '',
        harnessRef: typeof record.harnessRef === 'string' ? record.harnessRef : fallback.harnessRef,
        baseRecipePath: typeof record.baseRecipePath === 'string' ? record.baseRecipePath : '',
        baseRecipeHash: typeof record.baseRecipeHash === 'string' ? record.baseRecipeHash : '',
        reviewMode,
        reviewName: typeof record.reviewName === 'string' ? record.reviewName : '',
        reviewVersion: typeof record.reviewVersion === 'string' ? record.reviewVersion : '',
        runner,
        model,
        repeat: typeof record.repeat === 'boolean' ? record.repeat : false,
      },
    ];
  });
  return sanitized.length ? sanitized : defaultRows();
}

export function sanitizeSelectedCases(value: unknown): EvalSelectedCase[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): EvalSelectedCase[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Partial<Record<keyof EvalSelectedCase, unknown>>;
    if (
      typeof item.selectionId !== 'string' ||
      typeof item.datasetItemId !== 'string' ||
      typeof item.sourceKey !== 'string'
    )
      return [];
    if (!item.source || typeof item.source !== 'object') return [];
    if (item.taskProfile !== 'fix-bug' && item.taskProfile !== 'dev') return [];
    return [
      {
        selectionId: item.selectionId,
        datasetItemId: item.datasetItemId,
        sourceKey: item.sourceKey,
        kind:
          item.kind === 'merged-pr' ||
          item.kind === 'prior-run' ||
          item.kind === 'package' ||
          item.kind === 'git-ref'
            ? item.kind
            : 'prior-run',
        source: item.source as EvalSelectedCase['source'],
        project: typeof item.project === 'string' ? item.project : '',
        label: typeof item.label === 'string' ? item.label : item.datasetItemId,
        taskProfile: item.taskProfile,
        objective: typeof item.objective === 'string' ? item.objective : '',
        objectiveHash: typeof item.objectiveHash === 'string' ? item.objectiveHash : 'default',
        statusLabel: typeof item.statusLabel === 'string' ? item.statusLabel : 'url',
        sourceStatusLabel:
          typeof item.sourceStatusLabel === 'string'
            ? item.sourceStatusLabel
            : item.statusLabel === 'manual'
              ? 'manual'
              : `${item.kind ?? 'source'} ${item.statusLabel ?? 'unknown'}`,
        runStatusLabel: typeof item.runStatusLabel === 'string' ? item.runStatusLabel : undefined,
        suitabilityLabel:
          typeof item.suitabilityLabel === 'string' ? item.suitabilityLabel : 'selectable',
        warnings: Array.isArray(item.warnings)
          ? item.warnings.filter((entry): entry is string => typeof entry === 'string')
          : [],
        runId: typeof item.runId === 'string' ? item.runId : undefined,
        familyId: typeof item.familyId === 'string' ? item.familyId : undefined,
        packagePath: typeof item.packagePath === 'string' ? item.packagePath : undefined,
      },
    ];
  });
}

export function enabledCandidateRows(rows: readonly CandidateRow[]): CandidateRow[] {
  return rows.filter((row) => row.enabled);
}

export function datasetIdForSelectedCases(
  selectedCases: readonly EvalSelectedCase[],
  fallbackProject: string,
): string {
  const projects = [...new Set(selectedCases.map((item) => item.project).filter(Boolean))].sort();
  const project =
    projects.length === 1
      ? projects[0]
      : projects.length > 1
        ? 'mixed-projects'
        : fallbackProject.trim() || 'project';
  return datasetIdFor({
    project,
    datasetItemIds: selectedCases.map((item) => item.datasetItemId),
  });
}

export function capGroupIdForDataset(datasetId: string): string {
  return `suite-${datasetId}`;
}

export function axisRef(pathOrName: string, hashOrRef = '', nameHint = '') {
  const trimmed = pathOrName.trim();
  const hash = hashOrRef.trim();
  if (!trimmed && !hash && !nameHint) return undefined;
  return {
    ...(nameHint ? { name: nameHint } : {}),
    ...(trimmed.includes('/') ? { path: trimmed } : trimmed ? { name: trimmed } : {}),
    ...(hash ? { hash } : {}),
  };
}

export function axesForCandidateRow(row: CandidateRow): EvalPackageAxes {
  return {
    template: axisRef(row.templatePath, row.templateHash),
    prompt: axisRef(row.promptName, row.promptHash),
    harness: harnessAxisForCandidateRow(row),
    baseRecipe: axisRef(row.baseRecipePath, row.baseRecipeHash),
    review: reviewAxisForCandidateRow(row),
    runner: row.runner.trim() ? { name: row.runner.trim() } : undefined,
    model: row.model.trim() ? { name: row.model.trim() } : undefined,
  };
}

export function harnessAxisForCandidateRow(row: CandidateRow) {
  const ref = row.harnessRef.trim();
  if (!ref) return undefined;
  return {
    name: 'recipe-harness',
    ...(ref === 'current' ? {} : { ref }),
  };
}

export function reviewAxisForCandidateRow(row: CandidateRow) {
  if (row.reviewMode === 'default') return undefined;
  if (row.reviewMode === 'custom') {
    const name = row.reviewName.trim();
    const version = row.reviewVersion.trim();
    return {
      name: name || 'custom',
      ...(version ? { version } : {}),
    };
  }
  return { name: 'none', version: 'first-pass' };
}

export function normalizedTrialSuffix(trialId: string): string {
  return trialId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 40);
}

export function evalRunTrialMatchesCell(
  runTrialId: string | undefined,
  cellTrialId: string | undefined,
): boolean {
  if (!runTrialId || !cellTrialId) return false;
  if (runTrialId === cellTrialId) return true;
  const suffix = normalizedTrialSuffix(cellTrialId);
  return Boolean(suffix) && runTrialId.endsWith(`-${suffix}`);
}

export function packageProjectionFromManifest(
  pkg: ResultPackageManifest,
  input: { caseId?: string; strategyId?: string; trialId?: string; label: string },
): PackageRow {
  return {
    rowOrigin: 'result',
    caseId: input.caseId,
    strategyId: input.strategyId,
    trialId: input.trialId,
    role: pkg.role ?? 'candidate',
    label: input.label,
    packageId: pkg.packageId,
    packageHash: pkg.packageHash,
    packagePath: '',
    runId: pkg.runId,
    source: pkg.source,
    axes: pkg.axes,
    status: pkg.status,
    diff: pkg.diff,
    metrics: pkg.metrics,
    visualEvidenceCount: pkg.visualEvidence.length,
    validationEvidenceCount: pkg.validationEvidence.length,
    reviewEvidenceCount: pkg.reviewEvidence.length,
    missingData: pkg.missingData,
  };
}

export function mockPackageSourceFromExperimentSource(
  source: EvalExperimentSource,
): ResultPackageManifest['source'] {
  if (source.kind === 'merged-pr') {
    const splitAt = source.ref.lastIndexOf('#');
    const repo = splitAt > 0 ? source.ref.slice(0, splitAt) : source.ref;
    const prNumber = splitAt > 0 ? Number(source.ref.slice(splitAt + 1)) : 0;
    return { kind: 'merged-pr', repo, prNumber: Number.isFinite(prNumber) ? prNumber : 0 };
  }
  if (source.kind === 'prior-run') return { kind: 'prior-run', runId: source.runId };
  if (source.kind === 'package')
    return {
      kind: 'package',
      packageId: `mock-package-${stableIdHash(source.packagePath)}`,
      packagePath: source.packagePath,
    };
  return {
    kind: 'git-ref',
    ref: source.ref,
    repository: source.repository,
    baseRef: source.baseRef,
    baseSha: source.baseSha,
    headRef: source.headRef,
    headSha: source.headSha,
  };
}

export function candidateTemplateChoices(
  taskProfile: EvalTaskProfile,
  options: readonly WorkerTemplateOption[],
): CandidateTemplateChoice[] {
  const dynamic = options
    .filter((option) => option.flowType === taskProfile)
    .map((option) => ({
      path: `templates/worker/${option.fileName}`,
      label: option.isDefault ? `${taskProfile} default` : (option.variant ?? option.fileName),
      description: option.isDefault
        ? 'Canonical project worker template.'
        : `Project worker template version: ${option.fileName}.`,
      promptName: taskProfile,
    }));
  return dynamic.length > 0 ? dynamic : [...CANDIDATE_TEMPLATE_OPTIONS];
}

export function candidateModelOptions(runner: string): string[] {
  return MODELS_BY_RUNNER[runner] ?? [runner ? 'default' : (DEFAULT_MODEL.codex ?? 'gpt-5.6-sol')];
}

export function applyCandidateRunner(row: CandidateRow, runner: string): CandidateRow {
  const models = candidateModelOptions(runner);
  return {
    ...row,
    runner,
    model: models.includes(row.model)
      ? row.model
      : (DEFAULT_MODEL[runner] ?? models[0] ?? row.model),
  };
}

export function candidateTemplateSummary(row: CandidateRow): string {
  const template = row.templateHash.trim() || row.templatePath.trim() || 'current project template';
  const prompt = row.promptHash.trim() || row.promptName.trim();
  return prompt ? `${template} · ${prompt}` : template;
}

export function templateName(row: CandidateRow): string {
  const pathPart = row.templatePath.trim().split('/').filter(Boolean).pop();
  return pathPart || row.promptName.trim() || 'template';
}

export function generatedCandidateLabel(
  row: CandidateRow,
  primaryCase: EvalSelectedCase | undefined,
  choices: readonly CandidateTemplateChoice[],
): string {
  const option = choices.find((entry) => entry.path === row.templatePath);
  const profile = primaryCase?.taskProfile === 'dev' ? 'Dev replay' : 'Bugfix replay';
  const template =
    option?.promptName === primaryCase?.taskProfile
      ? ''
      : ` · ${option?.label ?? templateName(row)}`;
  const runner = row.runner ? runnerLabel(row.runner) : 'runner';
  const model = row.model || 'model';
  return `${profile}${template} · ${runner} / ${model}`;
}

export function candidateLabel(
  row: CandidateRow,
  primaryCase: EvalSelectedCase | undefined,
  choices: readonly CandidateTemplateChoice[],
): string {
  return row.label.trim() || generatedCandidateLabel(row, primaryCase, choices);
}

export function candidateVariant(
  row: CandidateRow,
  primaryCase: EvalSelectedCase | undefined,
): string {
  return generatedCandidateVariant({
    taskProfile: primaryCase?.taskProfile ?? 'fix-bug',
    templateName: templateName(row),
    templateHash: row.templateHash.trim(),
    runner: row.runner.trim(),
    model: row.model.trim(),
    repeat: row.repeat,
  });
}

export function trialIdForCell(input: {
  datasetId: string;
  cellId: string;
  repeat: boolean;
  nonce: string | number;
}): string {
  return `cell-${stableIdHash(`${input.datasetId}|${input.cellId}|${input.repeat ? input.nonce : 'stable'}`).slice(0, 12)}`;
}

export interface EvalTrialStartParamsModel {
  project: string;
  experimentManifestPath: string;
  label: string;
  variant: string;
  axes: EvalPackageAxes;
  runner?: string;
  model?: string;
  repeat?: boolean;
  trialId: string;
  capGroupId: string;
  suiteId: string;
}

export interface EvalCellQueueRequestModel {
  queueKind: 'eval-cell';
  label: string;
  flowType: EvalTaskProfile;
  project: string;
  ticketOrPr: string;
  familyId: string;
  familyRootTicketOrPr: string;
  lane: 'comparison';
  variant: string;
  completionPolicy: 'artifact-only';
  runner?: string;
  model?: string;
  mode: 'validation';
  priority: 10;
  evalCell: {
    capGroupId: string;
    suiteId: string;
    cellId: string;
    caseSelectionId: string;
    candidateId: string;
    candidateLabel: string;
    experimentId: string;
    experimentKey: string;
    experimentManifestPath: string;
    trialId: string;
    trialStartParams: EvalTrialStartParamsModel;
  };
}

export function buildEvalCellQueueRequest(input: {
  selectedCase: EvalSelectedCase;
  row: CandidateRow;
  primaryCase: EvalSelectedCase | undefined;
  choices: readonly CandidateTemplateChoice[];
  projectFallback: string;
  evalResult: EvalExperimentCreateResult;
  datasetId: string;
  capGroupId: string;
  cellId: string;
  trialId: string;
}): EvalCellQueueRequestModel {
  const project = input.selectedCase.project || input.projectFallback.trim();
  const label = candidateLabel(input.row, input.primaryCase, input.choices);
  const variant = candidateVariant(input.row, input.primaryCase);
  const ticket = `EVAL-${input.evalResult.experimentKey.slice(0, 12).toUpperCase()}`;
  const trialStartParams: EvalTrialStartParamsModel = {
    project,
    experimentManifestPath: input.evalResult.experimentManifestPath,
    label,
    variant,
    axes: axesForCandidateRow(input.row),
    runner: input.row.runner.trim() || undefined,
    model: input.row.model.trim() || undefined,
    repeat: input.row.repeat || undefined,
    trialId: input.trialId,
    capGroupId: input.capGroupId,
    suiteId: input.datasetId,
  };
  return {
    queueKind: 'eval-cell',
    label: `${input.selectedCase.label} / ${label}`,
    flowType: input.selectedCase.taskProfile,
    project,
    ticketOrPr: ticket,
    familyId: input.evalResult.familyId,
    familyRootTicketOrPr: ticket,
    lane: 'comparison',
    variant,
    completionPolicy: 'artifact-only',
    runner: input.row.runner.trim() || undefined,
    model: input.row.model.trim() || undefined,
    mode: 'validation',
    priority: 10,
    evalCell: {
      capGroupId: input.capGroupId,
      suiteId: input.datasetId,
      cellId: input.cellId,
      caseSelectionId: input.selectedCase.selectionId,
      candidateId: input.row.id,
      candidateLabel: label,
      experimentId: input.evalResult.experimentId,
      experimentKey: input.evalResult.experimentKey,
      experimentManifestPath: input.evalResult.experimentManifestPath,
      trialId: input.trialId,
      trialStartParams,
    },
  };
}

export interface EvalPackageSnapshotModel {
  packagePath: string;
  pkg: ResultPackageManifest;
}

export function packageRowsForEvalCockpit(input: {
  evalResult: EvalExperimentCreateResult | null;
  evalResultsByCase: Readonly<Record<string, EvalExperimentCreateResult>>;
  appendResults: readonly EvalTrialStartResult[];
  appendResultsOverride: readonly EvalTrialStartResult[];
  snapshots: Iterable<EvalPackageSnapshotModel>;
  suiteCells: readonly EvalLaunchCell[];
}): PackageRow[] {
  const rows: PackageRow[] = [];
  const evalResults = Object.values(input.evalResultsByCase);
  const referenceResults = evalResults.length
    ? evalResults
    : input.evalResult
      ? [input.evalResult]
      : [];
  for (const result of referenceResults) {
    rows.push(
      packageProjectionFromManifest(result.referencePackage, {
        caseId: result.experimentManifest.case.caseId,
        label: `${result.experimentManifest.case.label ?? 'reference'} · reference`,
      }),
    );
  }
  for (const result of referenceResults) {
    const strategies = new Map(
      result.experimentManifest.candidateStrategies.map((strategy) => [
        strategy.strategyId,
        strategy,
      ]),
    );
    for (const trial of result.experimentManifest.trials ?? []) {
      const strategy = strategies.get(trial.strategyId);
      if (!trial.packagePath || !trial.packageId || !trial.packageHash) continue;
      rows.push({
        rowOrigin: 'manifest',
        caseId: trial.caseId,
        strategyId: trial.strategyId,
        trialId: trial.trialId,
        role: 'candidate',
        label: strategy?.label,
        packageId: trial.packageId,
        packageHash: trial.packageHash,
        packagePath: trial.packagePath,
        runId: trial.runId,
        candidateStrategyFingerprint: strategy?.candidateStrategyFingerprint,
        axes: strategy?.axes,
        status: 'draft',
        diff: {
          source: 'unavailable',
          available: false,
          files: 0,
          additions: 0,
          deletions: 0,
          kind: 'contribution',
          missingReason: 'package-not-loaded',
        },
        visualEvidenceCount: 0,
        validationEvidenceCount: 0,
        reviewEvidenceCount: 0,
        missingData: [],
      });
    }
  }
  const appendResultsByPackage = new Map<string, EvalTrialStartResult>();
  for (const result of input.appendResults)
    appendResultsByPackage.set(result.candidatePackage.packageId, result);
  for (const result of input.appendResultsOverride)
    appendResultsByPackage.set(result.candidatePackage.packageId, result);
  for (const result of appendResultsByPackage.values()) {
    const label =
      result.experimentManifest.candidateStrategies.find(
        (strategy) => strategy.strategyId === result.strategyId,
      )?.label ?? 'candidate';
    const row = packageProjectionFromManifest(result.candidatePackage, {
      caseId: result.experimentManifest.case.caseId,
      strategyId: result.strategyId,
      trialId: result.trialId,
      label,
    });
    const existing = rows.findIndex((item) => item.packageId === row.packageId);
    if (existing >= 0) rows[existing] = row;
    else rows.push(row);
  }
  for (const snapshot of input.snapshots) {
    const cell = input.suiteCells.find(
      (candidate) => candidate.packagePath === snapshot.packagePath,
    );
    const row = packageProjectionFromManifest(snapshot.pkg, {
      trialId: cell?.trialId,
      label: cell?.candidateLabel ?? snapshot.pkg.packageId,
    });
    const existing = rows.findIndex((item) => item.packageId === row.packageId);
    if (existing >= 0) rows[existing] = row;
    else rows.push(row);
  }
  return rows;
}
