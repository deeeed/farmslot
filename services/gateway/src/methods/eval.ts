import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type CandidateStrategy,
  type EvalExperimentCreateParams,
  type EvalExperimentCreateResult,
  type EvalExperimentManifest,
  type EvalExperimentSource,
  type EvalPackageAxes,
  type EvalPackageSource,
  type EvalRubricManifest,
  type EvalSuiteCapGetParams,
  type EvalSuiteCapGetResult,
  type EvalSuiteCapUpdateParams,
  type EvalSuiteCapUpdateResult,
  type EvalTrialResultGetParams,
  type EvalTrialResultGetResult,
  type EvalTrialStartParams,
  type EvalTrialStartResult,
  type ExperimentTrial,
  type FamilyDiffProvenance,
  type FamilyInputCommitMetadata,
  type FamilyObservabilityArtifact,
  isEvalPackageAxes,
  type ResultPackageManifest,
  type Run,
  type RunStartRefSource,
  type RunTicketData,
  type TemplateProvenance,
} from '@farmslot/protocol';

import { getQueueSnapshot, tryDispatchNext } from '../backlog/dispatch-queue.js';
import { loadProjectVars } from '../core/config.js';
import { getOrchestratorTaskRoot } from '../core/index.js';
import {
  CANDIDATE_PACKAGE_FILENAME,
  computeCandidateStrategyFingerprint,
  computeExperimentKey,
  computeObjectiveHash,
  EXPERIMENT_MANIFEST_FILENAME,
  fileExists,
  packageIdFor,
  readEvalExperimentManifest,
  readResultPackageManifest,
  REFERENCE_PACKAGE_FILENAME,
  RESULT_PACKAGE_DIR,
  unavailableDiff,
  visualEvidenceFromArtifacts,
  writeEvalExperimentManifest,
  writeJsonFile,
  writeResultPackageManifest,
} from '../evals/package-store.js';
import { evalSuiteCapUsage, setEvalSuiteCap } from '../evals/suite-cap-store.js';
import { fetchGitHubPR } from '../external/github.js';
import { loadProjectConfig } from '../fleet/state.js';
import { buildSmartBranch, ticketSlug } from '../intelligence/engine.js';
import { getRun, updateRun } from '../runs/store.js';
import { TEMPLATE_PROVENANCE_INPUT } from '../tasks/writer.js';

import {
  axesWithExecutionDefaults,
  harnessLifecycleForAxes,
  resolveCandidateTemplateProvenance,
} from './eval/candidate-setup.js';
import {
  type ResolvedEvalSource,
  resolveEvalSource,
  writeMergedPrInputs,
} from './eval/source-resolution.js';
import { runCreate } from './run.js';

const DEFAULT_RUBRIC_ID = 'eval-default';
const DEFAULT_RUBRIC_VERSION = '1';

function sourceSlug(source: EvalPackageSource): string {
  if (source.kind === 'merged-pr') return ticketSlug(`${source.repo}#${source.prNumber}`);
  if (source.kind === 'prior-run') return `run-${source.runId.slice(0, 8)}`;
  if (source.kind === 'package') return `package-${source.packageId.slice(0, 16)}`;
  return (
    ticketSlug(source.ref)
      .replace(/[^a-zA-Z0-9_.-]/g, '-')
      .slice(0, 80) || 'git-ref'
  );
}

function syntheticEvalTicket(experimentKey: string): string {
  return `EVAL-${experimentKey.slice(0, 12).toUpperCase()}`;
}

function defaultRubric(
  taskProfile: EvalExperimentCreateParams['taskProfile'],
  rubricId = DEFAULT_RUBRIC_ID,
  rubricVersion = DEFAULT_RUBRIC_VERSION,
): EvalRubricManifest {
  return {
    taskProfile,
    rubricId,
    rubricVersion,
    requiredEvidence: [
      { id: 'diff', label: 'Local diff captured', state: 'missing' },
      { id: 'report', label: 'Worker report captured', state: 'missing' },
      { id: 'visuals', label: 'Visual evidence captured when applicable', state: 'missing' },
    ],
  };
}

function commitMetadataFromDiff(diff: FamilyDiffProvenance): FamilyInputCommitMetadata | undefined {
  if (!diff.baseSha && !diff.headSha && !diff.baseRef && !diff.headRef) return undefined;
  const metadata: FamilyInputCommitMetadata = {
    ...(diff.repository ? { repository: diff.repository } : {}),
    ...(diff.baseRef ? { baseRef: diff.baseRef } : {}),
    ...(diff.baseSha ? { baseSha: diff.baseSha } : {}),
    ...(diff.headRef ? { headRef: diff.headRef } : {}),
    ...(diff.headSha ? { headSha: diff.headSha } : {}),
    capturedAt: diff.capturedAt ?? new Date().toISOString(),
    source: diff.repository || diff.prNumber ? 'github-pr' : 'local-git',
    ...(diff.missingReason ? { missingReason: diff.missingReason } : {}),
    ...(diff.error ? { error: diff.error } : {}),
  };
  if (typeof diff.prNumber === 'number') metadata.prNumber = diff.prNumber;
  return metadata;
}

function startRefSourceForReferencePackage(
  referencePackage: ResultPackageManifest,
): RunStartRefSource {
  const source = referencePackage.source;
  if (source.kind === 'merged-pr')
    return { kind: 'merged-pr', repo: source.repo, prNumber: source.prNumber };
  if (source.kind === 'package' && source.packagePath)
    return { kind: 'package', packagePath: source.packagePath };
  if (source.kind === 'git-ref')
    return { kind: 'git-ref', repository: source.repository, ref: source.ref };
  return { kind: 'manual' };
}

function sourceBaseSha(source: EvalPackageSource): string | undefined {
  if (source.kind === 'merged-pr' || source.kind === 'git-ref') return source.baseSha;
  return undefined;
}

function packagedReferenceBase(referencePackage: ResultPackageManifest): string | undefined {
  return (
    referencePackage.baseline?.baseSha ??
    sourceBaseSha(referencePackage.source) ??
    referencePackage.diff.baseSha
  );
}

async function priorRunReplayBase(
  source: Extract<EvalPackageSource, { kind: 'prior-run' }>,
  project: string,
): Promise<{ requestedRef: string; source: RunStartRefSource; auto: boolean } | undefined> {
  const originalRun = getRun(source.runId);
  const originalStartRef =
    originalRun?.startRef?.resolvedSha ?? originalRun?.startRef?.requestedRef;
  if (originalStartRef?.trim()) {
    return {
      requestedRef: originalStartRef.trim(),
      source: originalRun?.startRef?.source ?? { kind: 'manual' },
      auto: true,
    };
  }

  if (originalRun?.prNumber === undefined) return undefined;
  const projectConfig = await loadProjectConfig(project);
  const repo = projectConfig?.ci?.repo;
  if (!repo) return undefined;

  const pr = await fetchGitHubPR(`${repo}#${originalRun.prNumber}`);
  if (!pr.baseSha?.trim()) return undefined;
  return {
    requestedRef: pr.baseSha.trim(),
    source: { kind: 'merged-pr', repo, prNumber: originalRun.prNumber },
    auto: true,
  };
}

function referenceSourceLabel(source: EvalPackageSource): string {
  if (source.kind === 'prior-run') return `prior run ${source.runId.slice(0, 8)}`;
  if (source.kind === 'package') return `package ${source.packageId}`;
  if (source.kind === 'merged-pr') return `${source.repo}#${source.prNumber}`;
  return source.ref;
}

async function candidateStartRefForReferencePackage(
  params: Pick<EvalTrialStartParams, 'startRef'>,
  project: string,
  referencePackage: ResultPackageManifest,
): Promise<{ requestedRef: string; source: RunStartRefSource; auto: boolean }> {
  const explicit = params.startRef?.trim();
  if (explicit) return { requestedRef: explicit, source: { kind: 'manual' }, auto: false };

  const packagedBase = packagedReferenceBase(referencePackage);
  if (packagedBase?.trim()) {
    return {
      requestedRef: packagedBase.trim(),
      source: startRefSourceForReferencePackage(referencePackage),
      auto: true,
    };
  }

  const source = referencePackage.source;
  if (source.kind === 'prior-run') {
    const replayBase = await priorRunReplayBase(source, project);
    if (replayBase) return replayBase;
  }

  const sourceLabel = referenceSourceLabel(source);
  throw new Error(
    `Eval replay requires a concrete reference base commit/startRef before launch; ${sourceLabel} has no baseline.baseSha, source.baseSha, diff.baseSha, original startRef, or resolvable PR base. Recreate the Reference from a merged PR with base metadata, or pass an explicit startRef.`,
  );
}

function buildReferencePackage(input: {
  project: string;
  familyId: string;
  objectiveHash: string;
  taskProfile: EvalExperimentCreateParams['taskProfile'];
  experimentKey: string;
  resolved: ResolvedEvalSource;
  contextArtifacts: FamilyObservabilityArtifact[];
  existingPackage?: ResultPackageManifest;
}): ResultPackageManifest {
  if (input.existingPackage) {
    return {
      ...input.existingPackage,
      packageId: packageIdFor({ experimentKey: input.experimentKey, role: 'reference' }),
      packageHash: '',
      role: 'reference',
      source: input.resolved.source,
      project: input.project,
      familyId: input.familyId,
      objectiveHash: input.objectiveHash,
      taskProfile: input.taskProfile,
      baseline: input.existingPackage.baseline ?? commitMetadataFromDiff(input.resolved.diff),
      head: input.existingPackage.head,
      validationEvidence: [...input.contextArtifacts, ...input.existingPackage.validationEvidence],
    };
  }
  const commitMetadata = commitMetadataFromDiff(input.resolved.diff);
  const visualEvidence = visualEvidenceFromArtifacts(input.resolved.packageArtifacts, {
    id: 'eval-reference',
  });
  const missingData = ['rubric-unreviewed'];
  if (input.resolved.diff.available === false) missingData.unshift('reference-diff-missing');
  if (visualEvidence.length === 0)
    missingData.splice(missingData.length - 1, 0, 'visual-evidence-missing');
  return {
    version: 1,
    kind: 'result-package',
    packageId: packageIdFor({ experimentKey: input.experimentKey, role: 'reference' }),
    packageHash: '',
    status: 'final',
    createdAt: new Date().toISOString(),
    finalizedAt: new Date().toISOString(),
    project: input.project,
    familyId: input.familyId,
    objectiveHash: input.objectiveHash,
    taskProfile: input.taskProfile,
    source: input.resolved.source,
    role: 'reference',
    ...(commitMetadata ? { baseline: commitMetadata } : {}),
    diff: input.resolved.diff,
    axes: {},
    visualEvidence,
    validationEvidence: [...input.contextArtifacts, ...input.resolved.packageArtifacts],
    reviewEvidence: [],
    outcomeClaims: [],
    evidenceRequirements: defaultRubric(input.taskProfile).requiredEvidence,
    missingData,
  };
}

function caseIdFor(
  source: EvalPackageSource,
  objectiveHash: string,
  datasetItemId?: string,
): string {
  if (datasetItemId?.trim()) return ticketSlug(datasetItemId).slice(0, 80);
  return `case-${sourceSlug(source).slice(0, 40)}-${objectiveHash.slice(0, 8)}`;
}

function buildEvalRoot(
  project: string,
  projectJson: Record<string, unknown>,
  source: EvalPackageSource,
  experimentKey: string,
): string {
  return path.join(
    getOrchestratorTaskRoot(project, projectJson),
    'evals',
    `${sourceSlug(source)}-${experimentKey.slice(0, 12)}`,
  );
}

export async function evalExperimentCreate(
  params: EvalExperimentCreateParams,
): Promise<EvalExperimentCreateResult> {
  if (!params.project) throw new Error('Missing required field: project');
  if (!params.source) throw new Error('Missing required field: source');
  if (params.taskProfile !== 'dev' && params.taskProfile !== 'fix-bug')
    throw new Error('taskProfile must be dev or fix-bug');

  const { resolved, package: existingPackage } = await resolveEvalSource(
    params.project,
    params.source,
  );
  const rubricId = params.rubricId ?? DEFAULT_RUBRIC_ID;
  const rubricVersion = params.rubricVersion ?? DEFAULT_RUBRIC_VERSION;
  const objectiveHash =
    params.objectiveHash ??
    computeObjectiveHash({
      project: params.project,
      source: resolved.source,
      taskProfile: params.taskProfile,
      objective: params.objective,
    });
  const experimentKey = computeExperimentKey({
    project: params.project,
    source: resolved.source,
    taskProfile: params.taskProfile,
    objectiveHash,
    rubricId,
    rubricVersion,
    datasetId: params.datasetId,
    datasetItemId: params.datasetItemId,
  });

  const experimentId = `experiment-${experimentKey.slice(0, 20)}`;
  const familyId = params.familyId ?? experimentId;
  const evalCaseId = caseIdFor(resolved.source, objectiveHash, params.datasetItemId);
  const projectVars = await loadProjectVars(params.project);
  const evalRoot = buildEvalRoot(
    params.project,
    projectVars.projectJson as Record<string, unknown>,
    resolved.source,
    experimentKey,
  );
  const experimentManifestPath = path.join(evalRoot, 'artifacts', EXPERIMENT_MANIFEST_FILENAME);
  const referencePackagePath = path.join(
    evalRoot,
    'artifacts',
    RESULT_PACKAGE_DIR,
    REFERENCE_PACKAGE_FILENAME,
  );

  // Eval creation currently runs through a single gateway writer. If eval
  // dispatch becomes distributed, replace this read path with an atomic
  // create-or-read primitive.
  if (await fileExists(experimentManifestPath)) {
    const experimentManifest = await readEvalExperimentManifest(experimentManifestPath);
    if (experimentManifest.experimentKey !== experimentKey) {
      throw new Error(
        `Existing eval experiment manifest at ${experimentManifestPath} has stale experimentKey ${experimentManifest.experimentKey}; expected ${experimentKey}. Delete the stale eval experiment directory and recreate it with eval.experiment.create.`,
      );
    }
    let currentManifest = experimentManifest;
    if (
      currentManifest.datasetId !== params.datasetId ||
      currentManifest.datasetItemId !== params.datasetItemId
    ) {
      currentManifest = {
        ...currentManifest,
        datasetId: params.datasetId,
        datasetItemId: params.datasetItemId,
        updatedAt: new Date().toISOString(),
      };
      await writeEvalExperimentManifest(experimentManifestPath, currentManifest);
    }
    return {
      experimentId: currentManifest.experimentId,
      experimentKey: currentManifest.experimentKey,
      familyId: currentManifest.familyId,
      experimentManifestPath,
      experimentManifest: currentManifest,
      referencePackage: await readResultPackageManifest(currentManifest.case.referencePackagePath),
      referencePackagePath: currentManifest.case.referencePackagePath,
    };
  }

  await mkdir(path.join(evalRoot, 'artifacts', RESULT_PACKAGE_DIR), { recursive: true });
  const contextArtifacts = await writeMergedPrInputs(evalRoot, resolved);

  const referencePackage = await writeResultPackageManifest(
    referencePackagePath,
    buildReferencePackage({
      project: params.project,
      familyId,
      objectiveHash,
      taskProfile: params.taskProfile,
      experimentKey,
      resolved,
      contextArtifacts,
      existingPackage,
    }),
  );

  const experimentManifest: EvalExperimentManifest = {
    version: 1,
    kind: 'eval-experiment',
    experimentId,
    experimentKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    project: params.project,
    familyId,
    datasetId: params.datasetId,
    datasetItemId: params.datasetItemId,
    case: {
      caseId: evalCaseId,
      source: resolved.source,
      taskProfile: params.taskProfile,
      objectiveHash,
      referencePackageId: referencePackage.packageId,
      referencePackageHash: referencePackage.packageHash,
      referencePackagePath,
      label: resolved.referenceLabel,
    },
    rubric: defaultRubric(params.taskProfile, rubricId, rubricVersion),
    candidateStrategies: [],
    trials: [],
    missingData: referencePackage.missingData,
  };
  await writeEvalExperimentManifest(experimentManifestPath, experimentManifest);

  return {
    experimentId,
    experimentKey,
    familyId,
    experimentManifestPath,
    experimentManifest,
    referencePackage,
    referencePackagePath,
  };
}

function strategyIdFor(candidateStrategyFingerprint: string): string {
  return `strategy-${candidateStrategyFingerprint.slice(0, 12)}`;
}

function trialIdFor(candidateStrategyFingerprint: string, trialSuffix?: string): string {
  const suffix = trialSuffix ? `-${trialSuffix}` : '';
  return `trial-${candidateStrategyFingerprint.slice(0, 12)}${suffix}`;
}

export function candidateVariant(
  params: Pick<EvalTrialStartParams, 'variant' | 'label'>,
  candidateStrategyFingerprint: string,
  trialId?: string,
): string {
  const requested = (params.variant ?? params.label)?.trim();
  const fingerprintSuffix = candidateStrategyFingerprint.slice(0, 8);
  const trialSlug = trialId
    ? ticketSlug(trialId)
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[_.-]+|[_.-]+$/g, '')
        .slice(0, 16)
    : '';
  const trialSegment = trialSlug ? `-${trialSlug}` : '';
  const invariantSuffix = `-${fingerprintSuffix}${trialSegment}`;
  const baseBudget = Math.max(1, 48 - invariantSuffix.length);
  const base =
    (requested ? ticketSlug(requested) : 'eval')
      .replace(/[^a-zA-Z0-9_.-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[_.-]+|[_.-]+$/g, '')
      .slice(0, baseBudget)
      .replace(/[_.-]+$/g, '') || 'eval';
  return `${base}${invariantSuffix}`;
}

function assertEvalTrialStartParams(params: EvalTrialStartParams): void {
  if (!params.project?.trim()) throw new Error('Invalid eval.trial.start params: missing project');
  if (!params.experimentManifestPath?.trim())
    throw new Error('Invalid eval.trial.start params: missing experimentManifestPath');
  if (!params.axes || typeof params.axes !== 'object')
    throw new Error('Invalid eval.trial.start params: missing axes');
  if (!isEvalPackageAxes(params.axes))
    throw new Error('Invalid candidate axes: expected EvalPackageAxes');
}

async function readReferencePrInput(
  experimentManifestPath: string,
): Promise<{ title?: string; body?: string; url?: string } | null> {
  const manifestDir = path.dirname(experimentManifestPath);
  const candidates = [
    path.join(path.dirname(manifestDir), 'inputs', 'reference-pr.json'),
    path.join(manifestDir, 'inputs', 'reference-pr.json'),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, 'utf-8')) as {
        title?: string;
        body?: string;
        url?: string;
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

async function resolveCandidateSource(
  project: string,
  source: EvalExperimentSource | undefined,
): Promise<EvalPackageSource | undefined> {
  if (!source) return undefined;
  return (await resolveEvalSource(project, source)).resolved.source;
}

function trialSuffixFor(
  params: EvalTrialStartParams,
  explicitTrialId: string | undefined,
): string | undefined {
  if (explicitTrialId) return ticketSlug(explicitTrialId).slice(0, 40);
  if (params.repeat) return randomUUID().slice(0, 8);
  return undefined;
}

async function existingTrialStartResult(input: {
  existingTrial: ExperimentTrial | undefined;
  params: EvalTrialStartParams;
  explicitTrialId: string | undefined;
  experimentManifest: EvalExperimentManifest;
  strategyId: string;
  trialId: string;
  candidateStrategyFingerprint: string;
}): Promise<EvalTrialStartResult | undefined> {
  if (!input.existingTrial) return undefined;
  if (input.params.repeat && !input.explicitTrialId) return undefined;

  const existingRun = input.existingTrial.runId ? getRun(input.existingTrial.runId) : undefined;
  const existingTaskPath = existingRun?.taskFile ?? undefined;
  if (!input.existingTrial.packagePath) {
    throw new Error(`Existing trial has no package path: ${input.existingTrial.trialId}`);
  }
  return {
    experimentId: input.experimentManifest.experimentId,
    experimentKey: input.experimentManifest.experimentKey,
    deduped: true,
    strategyId: input.strategyId,
    trialId: input.trialId,
    candidateStrategyFingerprint: input.candidateStrategyFingerprint,
    experimentManifestPath: input.params.experimentManifestPath,
    experimentManifest: input.experimentManifest,
    candidatePackage: await readResultPackageManifest(input.existingTrial.packagePath),
    candidatePackagePath: input.existingTrial.packagePath,
    run: existingRun,
    taskPath: existingTaskPath,
    artifactDir: existingTaskPath
      ? path.join(path.dirname(existingTaskPath), 'artifacts')
      : undefined,
  };
}

function candidateDirectoryName(
  candidateStrategyFingerprint: string,
  trialSuffix?: string,
): string {
  const suffix = trialSuffix ? `-${trialSuffix}` : '';
  return `${candidateStrategyFingerprint.slice(0, 12)}${suffix}`;
}

function candidateMissingData(axes: EvalPackageAxes, templateMissingData: string[]): string[] {
  const missingData = [
    'candidate-run-pending',
    'eval-diff-pending',
    'visual-evidence-missing',
    'rubric-unreviewed',
  ];
  if (axes.harness) {
    missingData.push(
      'harness-install-pending',
      'harness-verify-pending',
      'harness-cleanup-pending',
    );
  }
  missingData.push(...templateMissingData);
  return missingData;
}

async function writeCandidateInputs(input: {
  candidateDir: string;
  experimentManifestPath: string;
  referencePackagePath: string;
  referencePackageHash: string;
  candidatePackagePath: string;
  strategyId: string;
  trialId: string;
  candidateStrategyFingerprint: string;
  startRef: string;
  startRefAuto: boolean;
  axes: EvalPackageAxes;
  templateContent?: string;
  templateProvenance?: TemplateProvenance;
}): Promise<void> {
  await writeJsonFile(path.join(input.candidateDir, 'inputs', 'eval-source.json'), {
    experimentManifestPath: input.experimentManifestPath,
    referencePackagePath: input.referencePackagePath,
    referencePackageHash: input.referencePackageHash,
    candidatePackagePath: input.candidatePackagePath,
    strategyId: input.strategyId,
    trialId: input.trialId,
    candidateStrategyFingerprint: input.candidateStrategyFingerprint,
    startRef: input.startRef,
  });
  await writeJsonFile(path.join(input.candidateDir, 'inputs', 'candidate-axes.json'), input.axes);
  if (input.templateContent) {
    await writeFile(
      path.join(input.candidateDir, 'inputs', 'candidate-template.md'),
      input.templateContent,
      'utf-8',
    );
  }
  if (input.templateProvenance) {
    await writeJsonFile(
      path.join(input.candidateDir, TEMPLATE_PROVENANCE_INPUT),
      input.templateProvenance,
    );
  }
  if (input.startRef) {
    await writeJsonFile(path.join(input.candidateDir, 'inputs', 'candidate-start-ref.json'), {
      requestedRef: input.startRef,
      source: input.startRefAuto ? 'eval-reference' : 'eval-candidate',
    });
  }
}

function evalReplayTitle(
  referencePackage: ResultPackageManifest,
  referencePrInput: { title?: string } | null,
  candidateStrategyFingerprint: string,
): string {
  const title = referencePrInput?.title?.trim();
  if (title) return title;
  const source = referencePackage.source;
  if (source.kind === 'merged-pr') {
    return source.title?.trim() || `Replay merged PR ${source.repo}#${source.prNumber}`;
  }
  return `Eval replay ${candidateStrategyFingerprint.slice(0, 8)}`;
}

function evalReplayDescription(
  referencePackage: ResultPackageManifest,
  referencePrInput: { body?: string; url?: string } | null,
  candidateStrategyFingerprint: string,
): string {
  const source = referencePackage.source;
  const body = referencePrInput?.body?.trim();
  if (source.kind === 'merged-pr' && body) {
    return [
      `Artifact-only replay for ${source.repo}#${source.prNumber}.`,
      referencePrInput?.url ? `Reference PR: ${referencePrInput.url}` : '',
      body,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return `Eval replay ${candidateStrategyFingerprint.slice(0, 8)}`;
}

function evalReplayAcceptanceCriteria(referencePackage: ResultPackageManifest): string[] {
  if (referencePackage.source.kind === 'merged-pr') {
    return [
      'Recreate the behavior documented by the reference PR and produce local artifacts only.',
    ];
  }
  return ['Replay the same task format as the reference and produce local artifacts only.'];
}

function buildEvalReplayTicketData(input: {
  originalRun?: Run;
  referencePackage: ResultPackageManifest;
  referencePrInput: { title?: string; body?: string; url?: string } | null;
  candidateStrategyFingerprint: string;
}): RunTicketData {
  if (input.originalRun?.ticketData) return input.originalRun.ticketData;
  return {
    source: input.referencePackage.source.kind === 'merged-pr' ? 'github' : 'manual',
    title: evalReplayTitle(
      input.referencePackage,
      input.referencePrInput,
      input.candidateStrategyFingerprint,
    ),
    description: evalReplayDescription(
      input.referencePackage,
      input.referencePrInput,
      input.candidateStrategyFingerprint,
    ),
    acceptanceCriteria: evalReplayAcceptanceCriteria(input.referencePackage),
    affectedArea: 'eval',
    stepsToReproduce: [],
    screenshots: [],
    labels: ['eval', 'artifact-only'],
  };
}

export async function evalTrialStart(
  params: EvalTrialStartParams,
  emit: (event: string, payload: unknown) => void,
  options: { beforeCreate?: () => void } = {},
): Promise<EvalTrialStartResult> {
  assertEvalTrialStartParams(params);
  const experimentManifest = await readEvalExperimentManifest(params.experimentManifestPath);
  if (experimentManifest.project !== params.project)
    throw new Error(
      `Experiment manifest project mismatch: expected ${params.project}, got ${experimentManifest.project}`,
    );
  const evalCase = experimentManifest.case;
  const referencePackage = await readResultPackageManifest(evalCase.referencePackagePath);
  const candidateStartRef = await candidateStartRefForReferencePackage(
    params,
    params.project,
    referencePackage,
  );
  const axesDefaults = axesWithExecutionDefaults(params.axes, params);
  const templateResolution = await resolveCandidateTemplateProvenance(
    params.project,
    evalCase.taskProfile,
    axesDefaults,
  );
  const axes = templateResolution.axes;
  if (!isEvalPackageAxes(axes)) throw new Error('Invalid candidate axes: expected EvalPackageAxes');
  if (axes.template && (await loadProjectConfig(params.project))?.executionTemplates) {
    throw new Error(
      'Template-variant eval axes are not supported for projects using execution_templates. Use an exact execution-template selection outside the eval variant axis.',
    );
  }
  const harnessLifecycle = harnessLifecycleForAxes(params.project, axes);
  const candidateSource = await resolveCandidateSource(params.project, params.source);
  const candidateStrategyFingerprint = computeCandidateStrategyFingerprint({
    axes,
    source: candidateSource,
    startRef: candidateStartRef.requestedRef,
    taskProfile: evalCase.taskProfile,
  });
  const explicitTrialId = params.trialId?.trim() || undefined;
  const strategyId = strategyIdFor(candidateStrategyFingerprint);
  const trialSuffix = trialSuffixFor(params, explicitTrialId);
  const trialId = trialIdFor(candidateStrategyFingerprint, trialSuffix);
  const variant = candidateVariant(params, candidateStrategyFingerprint, trialSuffix);

  const existingTrial = experimentManifest.trials.find(
    (trial) =>
      trial.caseId === evalCase.caseId &&
      trial.strategyId === strategyId &&
      trial.trialId === trialId,
  );
  const dedupedResult = await existingTrialStartResult({
    existingTrial,
    params,
    explicitTrialId,
    experimentManifest,
    strategyId,
    trialId,
    candidateStrategyFingerprint,
  });
  if (dedupedResult) return dedupedResult;

  const evalRoot = path.dirname(path.dirname(params.experimentManifestPath));
  const candidateDir = path.join(
    evalRoot,
    'candidates',
    candidateDirectoryName(candidateStrategyFingerprint, trialSuffix),
  );
  const artifactsDir = path.join(candidateDir, 'artifacts');
  const packageDir = path.join(artifactsDir, RESULT_PACKAGE_DIR);
  const candidatePackagePath = path.join(packageDir, CANDIDATE_PACKAGE_FILENAME);
  await mkdir(packageDir, { recursive: true });

  const candidatePackageDraft = await writeResultPackageManifest(candidatePackagePath, {
    version: 1,
    kind: 'result-package',
    packageId: packageIdFor({
      experimentKey: experimentManifest.experimentKey,
      role: 'candidate',
      candidateStrategyFingerprint,
      trialId,
    }),
    packageHash: '',
    status: 'draft',
    createdAt: new Date().toISOString(),
    project: params.project,
    familyId: experimentManifest.familyId,
    objectiveHash: evalCase.objectiveHash,
    taskProfile: evalCase.taskProfile,
    source: candidateSource ?? referencePackage.source,
    productRef: {
      requestedRef: candidateStartRef.requestedRef,
      source: candidateStartRef.auto ? 'eval-reference' : 'eval-candidate',
    },
    role: 'candidate',
    diff: unavailableDiff('eval-diff-pending'),
    axes,
    visualEvidence: [],
    validationEvidence: [],
    reviewEvidence: [],
    outcomeClaims: [],
    evidenceRequirements: experimentManifest.rubric.requiredEvidence,
    templateProvenance: templateResolution.provenance,
    harnessLifecycle,
    missingData: candidateMissingData(axes, templateResolution.missingData),
  });

  await writeCandidateInputs({
    candidateDir,
    experimentManifestPath: params.experimentManifestPath,
    referencePackagePath: evalCase.referencePackagePath,
    referencePackageHash: referencePackage.packageHash,
    candidatePackagePath,
    strategyId,
    trialId,
    candidateStrategyFingerprint,
    startRef: candidateStartRef.requestedRef,
    startRefAuto: candidateStartRef.auto,
    axes,
    templateContent: templateResolution.templateContent,
    templateProvenance: templateResolution.provenance,
  });

  const flowType = evalCase.taskProfile;
  const originalRun =
    referencePackage.source.kind === 'prior-run'
      ? getRun(referencePackage.source.runId)
      : undefined;
  const referencePrInput =
    referencePackage.source.kind === 'merged-pr'
      ? await readReferencePrInput(params.experimentManifestPath)
      : null;
  const ticketOrPr =
    originalRun?.ticketOrPr ?? syntheticEvalTicket(experimentManifest.experimentKey);
  const branch = buildSmartBranch(
    flowType,
    ticketOrPr,
    `eval-${candidateStrategyFingerprint.slice(0, 8)}`,
    undefined,
    variant,
  );
  const ticketData = buildEvalReplayTicketData({
    originalRun,
    referencePackage,
    referencePrInput,
    candidateStrategyFingerprint,
  });
  const evalEngineState = {
    evalExperiment: {
      capGroupId: params.capGroupId,
      suiteId: params.suiteId,
      experimentId: experimentManifest.experimentId,
      experimentKey: experimentManifest.experimentKey,
      experimentManifestPath: params.experimentManifestPath,
      packagePath: candidatePackagePath,
      candidateStrategyFingerprint,
      trialId,
    },
  };

  const result = await runCreate(
    {
      flowType,
      project: params.project,
      ticketOrPr,
      familyId: experimentManifest.familyId,
      familyRootTicketOrPr: ticketOrPr,
      branch,
      ticketData,
      engineState: evalEngineState,
      startRef: candidateStartRef.requestedRef,
      startRefSource: candidateStartRef.source,
      completionPolicy: 'artifact-only',
      lane: 'comparison',
      variant,
      slotId: params.slotId,
      allowedSlots: params.allowedSlots,
      runner: params.runner,
      model: params.model,
      effort: params.effort,
      app: params.app,
      safetyTier: params.safetyTier,
      taskTemplate: templateResolution.taskTemplate?.variant
        ? templateResolution.taskTemplate
        : undefined,
    },
    emit,
    { beforeCreate: options.beforeCreate },
  );

  const run = updateRun(result.run.id, {
    summary: `${flowType === 'fix-bug' ? 'Bugfix' : 'Dev'} eval replay ${candidateStrategyFingerprint.slice(0, 8)} for ${experimentManifest.experimentId}`,
    templateProvenance: templateResolution.provenance ?? null,
  });

  const candidatePackage = await writeResultPackageManifest(candidatePackagePath, {
    ...candidatePackageDraft,
    runId: run.id,
    familyId: run.familyId,
  });
  const candidateStrategy: CandidateStrategy = {
    strategyId,
    label: params.label ?? `candidate ${candidateStrategyFingerprint.slice(0, 8)}`,
    axes,
    candidateStrategyFingerprint,
  };
  const trial: ExperimentTrial = {
    trialId,
    strategyId,
    caseId: evalCase.caseId,
    status: 'running',
    runId: run.id,
    packageId: candidatePackage.packageId,
    packageHash: candidatePackage.packageHash,
    packagePath: candidatePackagePath,
    startedAt: run.createdAt,
    missingData: candidatePackage.missingData,
  };
  const updatedEvalExperimentManifest: EvalExperimentManifest = {
    ...experimentManifest,
    updatedAt: new Date().toISOString(),
    candidateStrategies: experimentManifest.candidateStrategies.some(
      (strategy) => strategy.strategyId === strategyId,
    )
      ? experimentManifest.candidateStrategies
      : [...experimentManifest.candidateStrategies, candidateStrategy],
    trials: [...experimentManifest.trials, trial],
  };
  await writeEvalExperimentManifest(params.experimentManifestPath, updatedEvalExperimentManifest);
  await writeEvalExperimentManifest(
    path.join(artifactsDir, EXPERIMENT_MANIFEST_FILENAME),
    updatedEvalExperimentManifest,
  );

  return {
    experimentId: updatedEvalExperimentManifest.experimentId,
    experimentKey: updatedEvalExperimentManifest.experimentKey,
    deduped: false,
    strategyId,
    trialId,
    candidateStrategyFingerprint,
    experimentManifestPath: params.experimentManifestPath,
    experimentManifest: updatedEvalExperimentManifest,
    candidatePackage,
    candidatePackagePath,
    run,
    taskPath: run.taskFile ?? undefined,
    artifactDir: run.taskFile ? path.join(path.dirname(run.taskFile), 'artifacts') : artifactsDir,
  };
}

export async function evalTrialResultGet(
  params: EvalTrialResultGetParams,
): Promise<EvalTrialResultGetResult> {
  const runId = params.runId?.trim();
  if (!runId) throw new Error('Invalid eval.trial.result.get params: missing runId');
  const run = getRun(runId);
  if (!run) throw new Error(`Eval trial run not found: ${runId}`);
  const link = run.engineState?.evalExperiment;
  if (!link) throw new Error(`Run ${runId} is not linked to an eval experiment`);
  const candidatePackage = await readResultPackageManifest(link.packagePath);
  const experimentManifest = await readEvalExperimentManifest(link.experimentManifestPath);
  return {
    run,
    candidatePackage,
    candidatePackagePath: link.packagePath,
    experimentManifest,
  };
}

export function evalSuiteCapGet(params: EvalSuiteCapGetParams): EvalSuiteCapGetResult {
  return evalSuiteCapUsage(params.capGroupId, getQueueSnapshot());
}

export async function evalSuiteCapUpdate(
  params: EvalSuiteCapUpdateParams,
): Promise<EvalSuiteCapUpdateResult> {
  await setEvalSuiteCap(params.capGroupId, params.cap, params.suiteId);
  tryDispatchNext().catch((error) => {
    console.error(`[eval-cap] dispatch after cap update failed: ${(error as Error).message}`);
  });
  return evalSuiteCapUsage(params.capGroupId, getQueueSnapshot());
}
