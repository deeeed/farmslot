import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  buildFamilySummary,
  type FamilyLearningEntry,
  type FamilyObservabilityArtifact,
  type FamilyObservabilityRunSummary,
  type FamilyObservabilitySnapshot,
  type FamilyObservabilityStep,
  type FamilyRecipeProvenance,
  FLOW_WORKER_REPORT_ARTIFACTS,
  GATE_SUMMARY_KINDS,
  parseGitHubRef,
  prNumberFromRunInput,
  type RecipeQualitySignal,
  type RelatedRunSummary,
  type Run,
} from '@farmslot/protocol';

import { readPortableTextIfExists } from '../live-recipe/context.js';
import { loadRecipeQualityEvaluation } from '../quality/recipe-quality.js';
import { buildRetrospectivePayload } from '../run-completion/orchestrator.js';
import { buildGateSummary } from '../run-engine/gate-summary.js';
import { runDurationMs } from '../runs/run-duration.js';
import { getAllRuns } from '../runs/store.js';

import { dedupeArtifacts, inferInputPurpose, inferPurpose, stepArtifacts } from './artifacts.js';
import {
  buildFamilyChangeLedger,
  isExpectedAbsentContributionDiff,
  isExpectedNoSourceDiff,
  isPrReviewDiffAuthoritative,
  readDiffProvenance,
  readInputDiffProvenance,
  readIterationDiffProvenance,
} from './change-ledger.js';
import { buildEvalExperimentProjections } from './eval-experiments.js';
import { isMissingPathError, readJsonIfExists, readTextIfExists, statIfPresent } from './io.js';
import { buildFamilyStateSummary, sortRunsByFreshness } from './state.js';
import { buildFamilyObservabilityTokenSummary } from './token-summary.js';

const FAMILY_EVIDENCE_PURPOSES = new Set([
  'screenshot',
  'screenshot-before',
  'screenshot-after',
  'video',
  'video-before',
  'video-after',
  'report',
  'review',
]);
const MAX_TASK_ARTIFACT_SCAN_DEPTH = 8;
const MAX_TASK_ARTIFACT_SCAN_FILES = 2000;

interface ResolvedRecipeProvenance {
  provenance: FamilyRecipeProvenance;
  recipeJson: string;
  recipeQualityArtifact: FamilyObservabilityRunSummary['recipeQualityArtifact'];
  recipeQuality: RecipeQualitySignal;
  recipeArtifacts: FamilyObservabilityArtifact[];
  workerReport: string | null;
  workerLearnings: string | null;
}

interface AmbiguousRecipeProvenance {
  provenance: FamilyRecipeProvenance;
}

type RecipeProvenanceRecovery = ResolvedRecipeProvenance | AmbiguousRecipeProvenance | null;

interface ScannedTaskArtifacts {
  artifacts: FamilyObservabilityArtifact[];
  truncated: boolean;
}

async function readWorkerReportForFlow(
  taskDir: string,
  flowType: Run['flowType'],
): Promise<string | null> {
  const candidates = FLOW_WORKER_REPORT_ARTIFACTS[flowType] ?? ['report.md'];
  for (const fileName of candidates) {
    const text = await readTextIfExists(path.join(taskDir, 'artifacts', fileName));
    if (text?.trim()) return text;
  }
  return null;
}

function runTaskDir(run: Pick<Run, 'taskFile'>): string | null {
  return run.taskFile ? path.dirname(run.taskFile) : null;
}

async function readRunArtifactText(
  run: Pick<Run, 'taskFile' | 'slotId' | 'project'>,
  relativePath: string,
): Promise<string | null> {
  const taskDir = runTaskDir(run);
  if (!taskDir) return null;
  // Route through the cached readPortableTextIfExists so a slot-panel-open burst
  // (which fans through both attachLiveRecipeContext and family-observability paths)
  // shares one round trip per artifact instead of duplicating reads under two helpers.
  // The Pick must include `project` — readPortableTextIfExists transitively calls
  // resolveWorkerTaskDir which reads run.project; the prior `run as Run` cast erased
  // it and silently fell back to DEFAULT_TASK_DIR for projects with custom task_dir.
  return readPortableTextIfExists(run, path.join(taskDir, 'artifacts', relativePath));
}

function familyReferenceSet(familyRuns: Run[]): Set<string> {
  const refs = new Set<string>();
  for (const run of familyRuns) {
    if (run.ticketOrPr) refs.add(run.ticketOrPr);
    if (run.familyRootTicketOrPr) refs.add(run.familyRootTicketOrPr);
  }
  return refs;
}

function runPrNumberForRelation(
  run: Pick<Run, 'flowType' | 'ticketOrPr' | 'familyRootTicketOrPr' | 'prNumber'>,
): number | null {
  return (
    run.prNumber ??
    parseGitHubRef(run.ticketOrPr)?.number ??
    parseGitHubRef(run.familyRootTicketOrPr)?.number ??
    prNumberFromRunInput(run) ??
    null
  );
}

function familyPrSet(familyRuns: Run[]): Set<number> {
  return new Set(
    familyRuns.flatMap((run) => {
      const prNumber = runPrNumberForRelation(run);
      return prNumber == null ? [] : [prNumber];
    }),
  );
}

function familyBranchSet(familyRuns: Run[]): Set<string> {
  return new Set(familyRuns.flatMap((run) => (run.branch ? [run.branch] : [])));
}

async function resolveHistoricalRecipeProvenance(
  familyRuns: Run[],
  allRuns: Run[],
): Promise<RecipeProvenanceRecovery> {
  if (familyRuns.length === 0 || allRuns.length === 0) return null;
  if (
    (await Promise.all(familyRuns.map((run) => readRunArtifactText(run, 'recipe.json')))).some(
      Boolean,
    )
  )
    return null;

  const familyIds = new Set(familyRuns.map((run) => run.id));
  const familyId = familyRuns[0].familyId;
  const project = familyRuns[0].project;
  const refs = familyReferenceSet(familyRuns);
  const prs = familyPrSet(familyRuns);
  const branches = familyBranchSet(familyRuns);

  const candidates: Run[] = [];
  for (const run of allRuns) {
    if (familyIds.has(run.id)) continue;
    if (run.familyId === familyId) continue;
    if (run.project !== project) continue;
    if (run.status !== 'done') continue;
    if (!run.taskFile) continue;
    const branchMatches = branches.size === 0 || (run.branch != null && branches.has(run.branch));
    if (!branchMatches) continue;

    const prMatches = prs.size > 0 && typeof run.prNumber === 'number' && prs.has(run.prNumber);
    const refMatches =
      refs.has(run.ticketOrPr) ||
      (run.familyRootTicketOrPr != null && refs.has(run.familyRootTicketOrPr));
    if (prs.size > 0 ? !prMatches : !refMatches) continue;
    if (!(await readRunArtifactText(run, 'recipe.json'))) continue;
    candidates.push(run);
  }

  if (candidates.length === 0) return null;
  const sorted = sortRunsByFreshness(candidates);
  if (sorted.length > 1) {
    return {
      provenance: {
        source: 'historical-run',
        status: 'ambiguous',
        reason:
          'Multiple historical runs match the family project, PR or ticket, branch, and recipe artifact.',
        candidateRunIds: sorted.map((run) => run.id),
      },
    };
  }

  const sourceRun = sorted[0];
  const sourceTaskDir = runTaskDir(sourceRun);
  const recipeJson = await readRunArtifactText(sourceRun, 'recipe.json');
  if (!recipeJson || !sourceTaskDir) return null;
  const reportCandidates = FLOW_WORKER_REPORT_ARTIFACTS[sourceRun.flowType] ?? ['report.md'];
  let workerReport: string | null = null;
  for (const fileName of reportCandidates) {
    const text = await readRunArtifactText(sourceRun, fileName);
    if (text?.trim()) {
      workerReport = text;
      break;
    }
  }
  const workerLearnings = await readRunArtifactText(sourceRun, 'learnings.md');
  const recipeQualityEvaluation = await loadRecipeQualityEvaluation({
    run: sourceRun,
    workerReport,
    recipeJson,
    recipeCoverage: await readRunArtifactText(sourceRun, 'recipe-coverage.md'),
  });
  const recoveredSourceArtifacts = (await buildRunArtifacts(sourceRun)).map((artifact) => ({
    ...artifact,
    source: 'recovered-provenance' as const,
    sourceRunId: sourceRun.id,
    sourceFamilyId: sourceRun.familyId,
  }));

  return {
    provenance: {
      source: 'historical-run',
      status: 'resolved',
      sourceRunId: sourceRun.id,
      sourceFamilyId: sourceRun.familyId,
      sourceTaskFile: sourceRun.taskFile ?? undefined,
      sourceArtifactPath: path.join(sourceTaskDir, 'artifacts', 'recipe.json'),
      sourceSlotId: sourceRun.slotId,
      reason:
        'Recovered from a unique historical run with the same project, PR or ticket, and branch.',
    },
    recipeJson,
    recipeQualityArtifact: recipeQualityEvaluation.artifact,
    recipeQuality: recipeQualityEvaluation.signal,
    recipeArtifacts: recoveredSourceArtifacts,
    workerReport,
    workerLearnings,
  };
}

async function scanTaskArtifacts(run: Run): Promise<ScannedTaskArtifacts> {
  if (!run.taskFile) return { artifacts: [], truncated: false };
  const artifactsDir = path.join(path.dirname(run.taskFile), 'artifacts');
  try {
    const collected: FamilyObservabilityArtifact[] = [];
    let truncated = false;
    const walk = async (dir: string, prefix = 'artifacts', depth = 0): Promise<void> => {
      if (collected.length >= MAX_TASK_ARTIFACT_SCAN_FILES) {
        truncated = true;
        return;
      }
      if (depth > MAX_TASK_ARTIFACT_SCAN_DEPTH) {
        truncated = true;
        console.warn(`[family-observability] artifact scan depth cap reached for ${dir}`);
        return;
      }
      const names = await readdir(dir);
      for (const name of names) {
        if (collected.length >= MAX_TASK_ARTIFACT_SCAN_FILES) {
          truncated = true;
          console.warn(`[family-observability] artifact scan file cap reached for run ${run.id}`);
          return;
        }
        const full = path.join(dir, name);
        const rel = `${prefix}/${name}`;
        const s = await statIfPresent(full);
        if (!s) continue;
        if (s.isDirectory()) {
          await walk(full, rel, depth + 1);
          continue;
        }
        if (!s.isFile()) continue;
        collected.push({
          runId: run.id,
          familyId: run.familyId,
          stepName: null,
          path: rel,
          purpose: inferPurpose(name),
          sizeBytes: s.size,
          source: 'task-artifact' as const,
        });
      }
    };
    await walk(artifactsDir);
    return { artifacts: collected, truncated };
  } catch (err) {
    if (isMissingPathError(err)) return { artifacts: [], truncated: false };
    throw err;
  }
}

async function scanTaskInputs(run: Run): Promise<FamilyObservabilityArtifact[]> {
  if (!run.taskFile) return [];
  const inputsDir = path.join(path.dirname(run.taskFile), 'inputs');
  try {
    const names = await readdir(inputsDir);
    const refs = await Promise.all(
      names.map(async (name): Promise<FamilyObservabilityArtifact | null> => {
        const full = path.join(inputsDir, name);
        const s = await statIfPresent(full);
        if (!s?.isFile()) return null;
        return {
          runId: run.id,
          familyId: run.familyId,
          stepName: null,
          path: `inputs/${name}`,
          purpose: inferInputPurpose(name),
          sizeBytes: s.size,
          source: 'task-input' as const,
        };
      }),
    );
    return refs.flatMap((entry) => (entry ? [entry] : []));
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
}

const recipeQualityRank: Record<RecipeQualitySignal['source'], number> = {
  'recipe-quality': 6,
  'human-grade': 5,
  'recipe-coverage': 4,
  report: 3,
  'recipe-json': 2,
  missing: 1,
};

function pickBestRecipeQuality(signals: RecipeQualitySignal[]): RecipeQualitySignal {
  return [...signals].sort((a, b) => {
    const rankDelta = recipeQualityRank[b.source] - recipeQualityRank[a.source];
    if (rankDelta !== 0) return rankDelta;
    const scoreA = a.score ?? -1;
    const scoreB = b.score ?? -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return 0;
  })[0];
}

function buildSelfReview(run: Run): FamilyObservabilityRunSummary['selfReview'] {
  const step = run.steps.find((candidate) => candidate.name === 'self-review');
  const outputs = (step?.outputs ?? {}) as Record<string, unknown>;
  const issues = Array.isArray(outputs.issues)
    ? outputs.issues.flatMap((issue) => {
        if (!issue || typeof issue !== 'object') return [];
        const rec = issue as Record<string, unknown>;
        const file = typeof rec.file === 'string' ? rec.file : null;
        const description = typeof rec.description === 'string' ? rec.description : null;
        if (!file || !description) return [];
        return [{ file, line: typeof rec.line === 'number' ? rec.line : undefined, description }];
      })
    : [];
  const summary =
    issues.length > 0
      ? issues.map((issue) => `${issue.file}: ${issue.description}`).join('; ')
      : null;
  return {
    verdict:
      typeof outputs.verdict === 'string'
        ? outputs.verdict
        : step?.status === 'skipped'
          ? 'skipped'
          : null,
    summary,
    issues,
  };
}

function buildCiChecks(run: Run): FamilyObservabilityRunSummary['ciChecks'] {
  const step = run.steps.find((candidate) => candidate.name === 'ci-watch');
  const outputs = (step?.outputs ?? {}) as Record<string, unknown>;
  const timeline = Array.isArray(outputs.checkTimeline) ? outputs.checkTimeline : [];
  const last =
    timeline.length > 0 &&
    timeline[timeline.length - 1] &&
    typeof timeline[timeline.length - 1] === 'object'
      ? (timeline[timeline.length - 1] as Record<string, unknown>)
      : null;
  if (last && typeof last.detail === 'string') {
    const parts = last.detail
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
    const checks: FamilyObservabilityRunSummary['ciChecks'] = [];
    for (const part of parts) {
      const [conclusion, names] = part.split(':').map((value) => value.trim());
      if (!names) continue;
      for (const name of names
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)) {
        checks.push({
          name,
          status: 'completed',
          conclusion: conclusion === 'pass' ? 'success' : 'failure',
        });
      }
    }
    if (checks.length > 0) return checks;
  }
  if (Array.isArray(outputs.failedChecks)) {
    return outputs.failedChecks
      .filter((name): name is string => typeof name === 'string')
      .map((name) => ({ name, status: 'completed', conclusion: 'failure' }));
  }
  if (typeof outputs.result === 'string') {
    return [
      {
        name: 'CI',
        status: 'completed',
        conclusion: outputs.result === 'pass' ? 'success' : 'failure',
      },
    ];
  }
  return [];
}

async function buildRunArtifactsWithScanState(
  run: Run,
): Promise<{ artifacts: FamilyObservabilityArtifact[]; artifactsTruncated: boolean }> {
  const taskArtifacts = await scanTaskArtifacts(run);
  const taskInputs = await scanTaskInputs(run);
  const fromSteps = run.steps.flatMap((step) =>
    stepArtifacts(run, step.name, step.outputs as Record<string, unknown> | undefined),
  );
  return {
    artifacts: dedupeArtifacts([...taskArtifacts.artifacts, ...taskInputs, ...fromSteps]),
    artifactsTruncated: taskArtifacts.truncated,
  };
}

async function buildRunArtifacts(run: Run): Promise<FamilyObservabilityArtifact[]> {
  return (await buildRunArtifactsWithScanState(run)).artifacts;
}

function buildStepLearnings(
  run: Run,
  stepName: string,
  outputs: Record<string, unknown> | undefined,
): FamilyLearningEntry[] {
  if (stepName !== 'self-review' || !Array.isArray(outputs?.issues)) return [];
  return outputs.issues.flatMap((issue, index) => {
    if (!issue || typeof issue !== 'object') return [];
    const rec = issue as Record<string, unknown>;
    const file = typeof rec.file === 'string' ? rec.file : null;
    const description = typeof rec.description === 'string' ? rec.description : null;
    if (!file || !description) return [];
    return [
      {
        id: `${run.id}:${stepName}:${index}`,
        runId: run.id,
        stepName,
        source: 'self-review' as const,
        title: `Self-review issue in ${file}`,
        summary: description,
        detail: typeof rec.line === 'number' ? `Line ${rec.line}` : undefined,
        createdAt: run.updatedAt,
        severity: 'warn' as const,
      },
    ];
  });
}

async function buildRunLearnings(run: Run): Promise<FamilyLearningEntry[]> {
  const learnings: FamilyLearningEntry[] = [];
  const taskDir = run.taskFile ? path.dirname(run.taskFile) : null;
  if (taskDir) {
    const workerLearnings = await readPortableTextIfExists(
      run,
      path.join(taskDir, 'artifacts', 'learnings.md'),
    );
    if (workerLearnings?.trim()) {
      learnings.push({
        id: `${run.id}:worker-learnings`,
        runId: run.id,
        source: 'worker-learnings',
        title: 'Worker learnings',
        summary: workerLearnings.trim().split('\n')[0] ?? 'Worker learnings',
        detail: workerLearnings.trim(),
        createdAt: run.updatedAt,
        severity: 'info',
      });
    }
    const familyScope = await readJsonIfExists<Record<string, unknown>>(
      path.join(taskDir, 'artifacts', 'family-scope.json'),
    );
    if (familyScope) {
      learnings.push({
        id: `${run.id}:family-scope`,
        runId: run.id,
        source: 'family-scope',
        title: 'Follow-up family scope',
        summary:
          typeof familyScope.scopeVerdict === 'string'
            ? familyScope.scopeVerdict
            : 'Family scope assessment',
        detail: typeof familyScope.notes === 'string' ? familyScope.notes : undefined,
        createdAt: run.updatedAt,
        severity: familyScope.scopeVerdict === 'partial-symptom-only' ? 'warn' : 'info',
      });
    }
    const reviewMd = await readTextIfExists(path.join(taskDir, 'artifacts', 'review.md'));
    if (reviewMd?.trim()) {
      learnings.push({
        id: `${run.id}:review-md`,
        runId: run.id,
        source: 'step-output',
        title: 'Review summary',
        summary: reviewMd.trim().split('\n')[0] ?? 'Review summary',
        detail: reviewMd.trim(),
        createdAt: run.updatedAt,
        severity: 'info',
      });
    }
    const reviewFeedback = await readTextIfExists(
      path.join(taskDir, 'artifacts', 'review-feedback.md'),
    );
    if (reviewFeedback?.trim()) {
      learnings.push({
        id: `${run.id}:review-feedback`,
        runId: run.id,
        source: 'step-output',
        title: 'Review feedback',
        summary: reviewFeedback.trim().split('\n')[0] ?? 'Review feedback',
        detail: reviewFeedback.trim(),
        createdAt: run.updatedAt,
        severity: 'warn',
      });
    }
    const lineComments = await readJsonIfExists<unknown[]>(
      path.join(taskDir, 'artifacts', 'line-comments.json'),
    );
    if (Array.isArray(lineComments) && lineComments.length > 0) {
      learnings.push({
        id: `${run.id}:line-comments`,
        runId: run.id,
        source: 'step-output',
        title: 'Review line comments',
        summary: `${lineComments.length} persisted review comment${lineComments.length === 1 ? '' : 's'} captured for follow-up context.`,
        detail: JSON.stringify(lineComments.slice(0, 10), null, 2),
        createdAt: run.updatedAt,
        severity: 'warn',
      });
    }
  }
  for (const step of run.steps) {
    learnings.push(
      ...buildStepLearnings(run, step.name, step.outputs as Record<string, unknown> | undefined),
    );
  }
  if (run.decisions.some((decision) => decision.type === 'retrospective' && decision.description)) {
    const decision = run.decisions.find(
      (candidate) => candidate.type === 'retrospective' && candidate.description,
    )!;
    learnings.push({
      id: `${run.id}:retrospective`,
      runId: run.id,
      source: 'retrospective',
      title: 'Retrospective',
      summary: decision.title,
      detail: decision.description,
      createdAt: decision.createdAt,
      severity: 'info',
    });
  }
  return dedupeLearnings(learnings);
}

function dedupeLearnings(items: FamilyLearningEntry[]): FamilyLearningEntry[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [item.runId, item.stepName ?? '', item.source, item.title, item.summary].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildRunSummary(
  run: Run,
  recipeRecovery: RecipeProvenanceRecovery = null,
): Promise<FamilyObservabilityRunSummary> {
  const taskDir = run.taskFile ? path.dirname(run.taskFile) : null;
  const workerReport = taskDir ? await readWorkerReportForFlow(taskDir, run.flowType) : null;
  const workerLearnings = taskDir
    ? await readPortableTextIfExists(run, path.join(taskDir, 'artifacts', 'learnings.md'))
    : null;
  const recipeJson = taskDir
    ? await readPortableTextIfExists(run, path.join(taskDir, 'artifacts', 'recipe.json'))
    : null;
  const resolvedRecovery =
    recipeRecovery && recipeRecovery.provenance.status === 'resolved'
      ? (recipeRecovery as ResolvedRecipeProvenance)
      : null;
  const ambiguousRecovery =
    recipeRecovery && recipeRecovery.provenance.status === 'ambiguous'
      ? (recipeRecovery as AmbiguousRecipeProvenance)
      : null;
  const effectiveRecipeJson = recipeJson ?? resolvedRecovery?.recipeJson ?? null;
  const effectiveWorkerReport =
    workerReport ?? (!recipeJson && resolvedRecovery ? resolvedRecovery.workerReport : null);
  const effectiveWorkerLearnings =
    workerLearnings ?? (!recipeJson && resolvedRecovery ? resolvedRecovery.workerLearnings : null);
  const recipeProvenance = !recipeJson ? (recipeRecovery?.provenance ?? null) : null;
  const familyScope = taskDir
    ? await readJsonIfExists<Record<string, unknown>>(
        path.join(taskDir, 'artifacts', 'family-scope.json'),
      )
    : null;
  const recoveredArtifactsForRun =
    !recipeJson && resolvedRecovery ? resolvedRecovery.recipeArtifacts : [];
  const ownArtifacts = await buildRunArtifactsWithScanState(run);
  const artifacts = dedupeArtifacts([...ownArtifacts.artifacts, ...recoveredArtifactsForRun]);
  const learnings = await buildRunLearnings(run);
  const selfReview = buildSelfReview(run);
  const currentRecipeQualityEvaluation = await loadRecipeQualityEvaluation({
    run,
    workerReport: effectiveWorkerReport,
    recipeJson: effectiveRecipeJson,
    recipeCoverage: taskDir
      ? await readTextIfExists(path.join(taskDir, 'artifacts', 'recipe-coverage.md'))
      : null,
  });
  const recipeQualityEvaluation =
    !recipeJson && resolvedRecovery
      ? { artifact: resolvedRecovery.recipeQualityArtifact, signal: resolvedRecovery.recipeQuality }
      : currentRecipeQualityEvaluation;

  const completeOutputs = (run.steps.find((step) => step.name === 'complete')?.outputs ??
    {}) as Record<string, unknown>;
  const diffProvenance = await readDiffProvenance(taskDir, completeOutputs, run.flowType);
  const inputDiffProvenance = await readInputDiffProvenance(taskDir);
  const iterationDiffProvenance = await readIterationDiffProvenance(taskDir);
  const displayDiffProvenance = iterationDiffProvenance?.available
    ? iterationDiffProvenance
    : isPrReviewDiffAuthoritative(run.flowType, inputDiffProvenance, run.parentRunId)
      ? inputDiffProvenance!
      : diffProvenance;
  const diffStat = {
    files: displayDiffProvenance.files,
    additions: displayDiffProvenance.additions,
    deletions: displayDiffProvenance.deletions,
    available: displayDiffProvenance.available,
  };

  const recipeQuality = recipeQualityEvaluation.signal;
  const decisions = await Promise.all(
    (run.decisions ?? []).map(async (decision) => {
      let payload = decision.payload;
      if (decision.type === 'retrospective' && !payload) {
        payload = await buildRetrospectivePayload(run, workerReport);
      }
      // Rebuild gateSummary from the live run (single source: run.metrics) so the
      // comparison/retrospective view never serves a token/byModel breakdown frozen
      // at gate time. buildGateSummary is a pure projection.
      if (payload?.kind === 'ready') {
        payload = {
          ...payload,
          gateSummary: buildGateSummary(run, GATE_SUMMARY_KINDS.publication, {
            gatePolicy: payload.prPackage?.gatePolicy ?? payload.gatePolicy,
            preparedPackage: payload.prPackage,
          }),
        };
      } else if (payload?.kind === 'retrospective') {
        payload = { ...payload, gateSummary: buildGateSummary(run, GATE_SUMMARY_KINDS.review) };
      }
      return payload === decision.payload ? decision : { ...decision, payload };
    }),
  );

  const steps: FamilyObservabilityStep[] = run.steps.map((step) => {
    const outputs = (step.outputs ?? {}) as Record<string, unknown>;
    const artifactsForStep = stepArtifacts(run, step.name, outputs);
    const learningsForStep = buildStepLearnings(run, step.name, outputs);
    const missingData: string[] = [];
    if (artifactsForStep.length === 0 && step.status === 'done') missingData.push('artifacts');
    if (learningsForStep.length === 0 && step.name === 'self-review' && step.status === 'done')
      missingData.push('self-review-details');
    return {
      runId: run.id,
      stepName: step.name,
      status: step.status,
      detail: step.detail,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      durationMs: step.durationMs,
      artifacts: artifactsForStep,
      learnings: learningsForStep,
      missingData,
    };
  });

  const missingData: string[] = [];
  if (!effectiveWorkerReport) missingData.push('worker-report');
  if (!effectiveWorkerLearnings) missingData.push('worker-learnings');
  if (!effectiveRecipeJson) missingData.push('recipe-json');
  if (ambiguousRecovery) missingData.push('recipe-provenance-ambiguous');
  if (!recipeQualityEvaluation.artifact) missingData.push('recipe-quality');
  if (
    !isPrReviewDiffAuthoritative(run.flowType, inputDiffProvenance, run.parentRunId) &&
    !isExpectedAbsentContributionDiff(run.flowType, diffProvenance) &&
    !diffStat.available &&
    !isExpectedNoSourceDiff(diffProvenance)
  ) {
    missingData.push(diffProvenance.missingReason ?? 'diff-stat');
  }
  if (
    !isPrReviewDiffAuthoritative(run.flowType, inputDiffProvenance, run.parentRunId) &&
    run.flowType !== 'review-pr' &&
    diffProvenance.source === 'legacy-step-output'
  ) {
    missingData.push('diff-artifact');
  }
  if (artifacts.length === 0) missingData.push('artifacts');
  if (ownArtifacts.artifactsTruncated) missingData.push('artifacts-truncated');

  const proofTargets = extractProofTargets(effectiveRecipeJson);

  return {
    runId: run.id,
    familyId: run.familyId,
    parentRunId: run.parentRunId ?? null,
    flowType: run.flowType,
    lane: run.lane,
    variant: run.variant ?? null,
    status: run.status,
    project: run.project,
    ticketOrPr: run.ticketOrPr,
    branch: run.branch,
    prNumber: prNumberFromRunInput(run),
    summary: run.summary ?? workerReport?.trim().split('\n')[0] ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    slotId: run.slotId,
    workerReport: effectiveWorkerReport,
    workerLearnings: effectiveWorkerLearnings,
    recipeJson: effectiveRecipeJson,
    recipeProvenance,
    recipeQualityArtifact: recipeQualityEvaluation.artifact,
    recipeQuality,
    diffStat,
    artifacts,
    learnings,
    steps,
    acceptanceCriteria: run.ticketData?.acceptanceCriteria?.filter(Boolean) ?? [],
    ciChecks: buildCiChecks(run),
    selfReview,
    familyScope: familyScope
      ? {
          originalFamilyScopeSummary:
            typeof familyScope.originalFamilyScopeSummary === 'string'
              ? familyScope.originalFamilyScopeSummary
              : undefined,
          currentTriggerSummary:
            typeof familyScope.currentTriggerSummary === 'string'
              ? familyScope.currentTriggerSummary
              : undefined,
          scopeVerdict:
            typeof familyScope.scopeVerdict === 'string' ? familyScope.scopeVerdict : undefined,
          notes: typeof familyScope.notes === 'string' ? familyScope.notes : undefined,
        }
      : null,
    humanGrade: run.humanGrade,
    proofTargets,
    decisions,
    metrics: { ...run.metrics, durationMs: runDurationMs(run) ?? run.metrics.durationMs },
    links: run.links,
    missingData,
  };
}

function extractProofTargets(
  recipeJson: string | null,
): { id: string; target: string }[] | undefined {
  if (!recipeJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(recipeJson);
  } catch (err) {
    console.warn(
      `[family-observability] failed to parse recipe proof targets: ${(err as Error).message.slice(0, 200)}`,
    );
    return undefined;
  }
  const raw = (parsed as { proofTargets?: unknown })?.proofTargets;
  if (!Array.isArray(raw)) return undefined;
  const result: { id: string; target: string }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : null;
    const target = typeof rec.claim === 'string' ? rec.claim : null;
    if (!id || !target) continue;
    result.push({ id, target });
  }
  return result.length > 0 ? result : undefined;
}

function buildRelatedByTicket(familyRuns: Run[], allRuns: Run[]): RelatedRunSummary[] {
  if (allRuns.length === 0) return [];
  const familyId = familyRuns[0].familyId;
  const project = familyRuns[0].project;
  const tickets = familyReferenceSet(familyRuns);
  const prs = familyPrSet(familyRuns);
  if (tickets.size === 0 && prs.size === 0) return [];
  const related = allRuns.filter((run) => {
    if (run.familyId === familyId || run.project !== project) return false;
    const prNumber = runPrNumberForRelation(run);
    return (
      tickets.has(run.ticketOrPr) ||
      (run.familyRootTicketOrPr != null && tickets.has(run.familyRootTicketOrPr)) ||
      (prNumber != null && prs.has(prNumber))
    );
  });
  return sortRunsByFreshness(related).map((run) => ({
    runId: run.id,
    familyId: run.familyId,
    flowType: run.flowType,
    status: run.status,
    project: run.project,
    ticketOrPr: run.ticketOrPr,
    branch: run.branch ?? null,
    prNumber: run.prNumber ?? null,
    summary: run.summary ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }));
}

function isFamilyEvidenceArtifact(artifact: FamilyObservabilityArtifact): boolean {
  const purpose = artifact.purpose;
  return (
    FAMILY_EVIDENCE_PURPOSES.has(purpose) ||
    /\.(png|jpe?g|gif|mp4|mov|webm)$/i.test(artifact.path) ||
    /(^|\/)(comments-report|report|review|review-feedback)\.md$/i.test(artifact.path)
  );
}

export async function buildFamilyObservabilitySnapshotFromRuns(
  runs: Run[],
  allRuns: Run[] = [],
): Promise<FamilyObservabilitySnapshot> {
  const familyRuns = sortRunsByFreshness(runs);
  if (familyRuns.length === 0) {
    throw new Error('No runs found for family snapshot');
  }
  const familyId = familyRuns[0].familyId;
  const summary = buildFamilyStateSummary(familyRuns);
  const recipeRecovery = await resolveHistoricalRecipeProvenance(familyRuns, allRuns);
  const runSummaries = await Promise.all(
    familyRuns.map((run) => buildRunSummary(run, recipeRecovery)),
  );
  const latestRun = familyRuns[0];
  const diffRun = runSummaries.find((run) => run.diffStat.available) ?? runSummaries[0];
  const recipeQuality = pickBestRecipeQuality(runSummaries.map((run) => run.recipeQuality));
  const evidence = dedupeArtifacts(
    runSummaries.flatMap((run) => run.artifacts.filter(isFamilyEvidenceArtifact)),
  );
  const learnings = dedupeLearnings(runSummaries.flatMap((run) => run.learnings)).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const rootRun = familyRuns.find((run) => run.id === familyId || run.parentRunId == null) ?? null;
  const familyRootTicketOrPr =
    summary?.familyRootTicketOrPr ?? latestRun.familyRootTicketOrPr ?? latestRun.ticketOrPr;
  const familyChangeLedger = await buildFamilyChangeLedger(
    familyRuns,
    runSummaries,
    familyRootTicketOrPr,
  );
  const experiments = await buildEvalExperimentProjections(familyRuns);
  // Single source of truth shared with the `#runs` family-group header so both
  // surfaces show the exact same family title.
  const familySummary = buildFamilySummary(rootRun, latestRun, familyRuns);
  const missingData: string[] = [];
  if (evidence.length === 0) missingData.push('family-evidence');
  if (!runSummaries.some((run) => run.recipeJson)) missingData.push('family-recipe');
  if (recipeRecovery?.provenance.status === 'ambiguous')
    missingData.push('family-recipe-provenance-ambiguous');
  if (!runSummaries.some((run) => run.diffStat.available)) missingData.push('family-diff-stat');
  if (learnings.length === 0) missingData.push('family-learnings');
  for (const experimentProjection of experiments) {
    if (experimentProjection.missingData.length)
      missingData.push(...experimentProjection.missingData);
  }

  return {
    familyId,
    familyRootTicketOrPr,
    project: latestRun.project,
    generatedAt: new Date().toISOString(),
    latestRunId: summary?.latestRunId ?? latestRun.id,
    latestPrNumber: summary?.latestPrNumber ?? latestRun.prNumber ?? null,
    workflowState: summary?.workflowState ?? 'complete',
    familyRunCount: summary?.familyRunCount ?? familyRuns.length,
    activeRunCount:
      summary?.activeRunCount ??
      familyRuns.filter((run) => !['done', 'failed', 'cancelled'].includes(run.status)).length,
    summary: familySummary,
    diffStat: { ...diffRun.diffStat, runId: diffRun.runId },
    familyChangeLedger,
    evidence,
    recipeQuality,
    learnings,
    runs: runSummaries,
    experiments: experiments.length ? experiments : undefined,
    tokenSummary: buildFamilyObservabilityTokenSummary(familyRuns, familyId),
    relatedByTicket: buildRelatedByTicket(familyRuns, allRuns),
    missingData: [...new Set(missingData)],
  };
}

export async function buildFamilyObservabilitySnapshot(
  familyId: string,
  project?: string,
): Promise<FamilyObservabilitySnapshot> {
  const allRuns = getAllRuns();
  const familyRuns = allRuns.filter(
    (run) => run.familyId === familyId && (!project || run.project === project),
  );
  if (familyRuns.length === 0) {
    throw new Error(
      `No runs found for family ${familyId}${project ? ` in project ${project}` : ''}`,
    );
  }
  return buildFamilyObservabilitySnapshotFromRuns(familyRuns, allRuns);
}
