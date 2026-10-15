import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ReadyGatePrPackage,
  ResultPackageManifest,
  Run,
  RunDecision,
} from '@farmslot/protocol';

import { retainFixtureTask } from '../../../../packages/run-bundle/src/retained.test-support.js';
import { deleteRun, getRun, updateRun } from '../runs/store.js';

export const RECIPE_HARNESS_PROJECT_CONFIG = {
  eval_harnesses: {
    'recipe-harness': {
      repo_url: 'git@github.com:example-org/skills.git',
      path: 'domains/coding/skills/recipe-harness',
      source: 'example-org/skills/domains/coding/skills/recipe-harness',
    },
  },
};

export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'comparison',
    variant: overrides.variant === undefined ? 'codex' : overrides.variant,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'interactive',
    devInteractiveProfile: overrides.devInteractiveProfile,
    prepareProfile: overrides.prepareProfile,
    status: overrides.status ?? 'ci-watching',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    domain: overrides.domain,
    executionTemplateId: overrides.executionTemplateId,
    executionTemplate: overrides.executionTemplate,
    app: overrides.app,
    slotId: overrides.slotId === undefined ? 'slot-1' : overrides.slotId,
    branch: overrides.branch ?? 'fix/proj-1-codex',
    completionPolicy: overrides.completionPolicy,
    taskFile: overrides.taskFile ?? null,
    activeTaskFile: overrides.activeTaskFile,
    prNumber: 'prNumber' in overrides ? overrides.prNumber : 42,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: 'gpt-5.5',
      runner: 'codex',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    allowedSlots: overrides.allowedSlots,
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-15T00:00:00.000Z',
    ticketData: overrides.ticketData,
    grade: overrides.grade,
    humanGrade: overrides.humanGrade,
    links: overrides.links,
    summary: overrides.summary ?? 'Original run summary',
    reviewTier: overrides.reviewTier,
    reviewMode: overrides.reviewMode,
    reviewValidationDepth: overrides.reviewValidationDepth,
    repeatReviewContext: overrides.repeatReviewContext,
    safetyTier: overrides.safetyTier,
    startRef: overrides.startRef,
    worktreeHeadAtDispatch: overrides.worktreeHeadAtDispatch,
    completedAt: overrides.completedAt,
    error: overrides.error,
    monitorState: overrides.monitorState,
    engineState: overrides.engineState,
  };
}

export function makeCollisionDecision(existingDirs: string[]): RunDecision {
  return {
    id: 'dec-1',
    type: 'engine_collision',
    title: 'collision',
    description: '',
    actions: [],
    createdAt: '2026-05-13T00:00:00Z',
    resolvedAt: '2026-05-13T00:00:01Z',
    resolvedAction: 'create-new',
    payload: { kind: 'collision', ticketSlug: 'proj-1', existingDirs, priorRunIds: [] },
  };
}

export function makeReadyGatePackage(
  overrides: Partial<ReadyGatePrPackage> = {},
): ReadyGatePrPackage {
  const headSha = overrides.headSha ?? 'abc1234';
  const diffStat = overrides.diffStat ?? { files: 1, additions: 2, deletions: 1 };
  return {
    id: overrides.id ?? 'pkg-1',
    artifactPath: overrides.artifactPath ?? 'artifacts/pr-package.json',
    packageHash: overrides.packageHash ?? 'hash-1',
    branch: overrides.branch ?? 'fix/proj-1-codex',
    remoteBranchRef: overrides.remoteBranchRef ?? 'origin/fix/proj-1-codex',
    headSha,
    diffStat,
    reviewSnapshot:
      'reviewSnapshot' in overrides
        ? overrides.reviewSnapshot
        : {
            source: 'local-git',
            baseRef: 'origin/main',
            baseSha: 'base-default',
            headSha,
            diffHash: 'diff-default',
            diffStat,
            capturedAt: '2026-04-15T00:00:00.000Z',
          },
    draftTitle: overrides.draftTitle ?? 'fix(command-center): harden gate',
    draftBody: overrides.draftBody ?? 'Body',
    evidenceManifest: overrides.evidenceManifest ?? [],
    selectedEvidenceKeys: overrides.selectedEvidenceKeys ?? [],
    validationSummaryPath: overrides.validationSummaryPath ?? null,
    validationSummaryHash: overrides.validationSummaryHash ?? null,
    reviewArtifactIds: overrides.reviewArtifactIds ?? [],
    dispatchMode: overrides.dispatchMode ?? 'interactive',
    gatePolicy: overrides.gatePolicy ?? {
      owner: 'human',
      dispatchMode: 'interactive',
      publishAuthority: 'human',
      reason: 'local-first publication requires human approval',
    },
    reviewPolicy: overrides.reviewPolicy,
    packageInputHash: overrides.packageInputHash,
    reviewSubjectHash:
      'reviewSubjectHash' in overrides ? overrides.reviewSubjectHash : 'subject-default',
    publicationTarget: overrides.publicationTarget ?? 'ready',
    publicationStatus: overrides.publicationStatus ?? 'not_published',
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
  };
}

export function makeEvalResultPackage(
  overrides: Partial<ResultPackageManifest> = {},
): ResultPackageManifest {
  return {
    version: 1,
    kind: 'result-package',
    packageId: 'eval-pkg-1',
    packageHash: 'pending',
    status: 'final',
    createdAt: '2026-05-25T00:00:00.000Z',
    finalizedAt: '2026-05-25T00:00:01.000Z',
    project: 'example-mobile-farm',
    familyId: 'eval-family-1',
    objectiveHash: 'objective-1',
    taskProfile: 'fix-bug',
    source: {
      kind: 'prior-run',
      runId: 'reference-run-1',
      familyId: 'reference-family-1',
    },
    role: 'candidate',
    diff: {
      source: 'artifact',
      available: true,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
    },
    axes: { template: { path: 'templates/worker/fix-bug.md' } },
    visualEvidence: [],
    validationEvidence: [],
    reviewEvidence: [],
    outcomeClaims: [],
    missingData: [],
    ...overrides,
  };
}

export async function deleteTestRunIfPresent(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;

  if (!['done', 'failed', 'cancelled'].includes(run.status)) {
    // These fixtures create runs only to exercise isolated package refresh paths.
    // Mark non-terminal test runs cancelled before deletion so cleanup uses the
    // same safety gate as production instead of swallowing delete failures.
    updateRun(runId, { status: 'cancelled' });
  }

  await deleteRun(runId);
}

/** Capture fixture bytes explicitly before exercising production readers. */
export async function retainRunFixture(run: Run, prepared?: ReadyGatePrPackage): Promise<void> {
  if (!run.taskFile) return;
  const { runBundleStore } = await import('../run-completion/retained-artifacts.js');
  const store = await runBundleStore(true);
  await retainFixtureTask(path.dirname(run.taskFile), run, store);
  if (run.output) {
    run.output.artifactBundle = run.artifactBundle;
    for (const decision of run.decisions)
      if (
        decision.payload?.kind === 'output-review' &&
        decision.payload.manifestDigest === run.output.manifestDigest
      )
        decision.payload.artifactBundle = run.artifactBundle;
  }
  if (prepared) {
    const { computeReadyGatePackageHash } = await import('../run-completion/ready-gate-package.js');
    const previousHash = prepared.packageHash;
    prepared.artifactBundle = run.artifactBundle;
    prepared.packageHash = computeReadyGatePackageHash(prepared);
    if (run.engineState?.publishGate?.packageHash === previousHash)
      run.engineState.publishGate.packageHash = prepared.packageHash;
    if (typeof prepared.artifactPath === 'string') {
      const file = path.join(path.dirname(run.taskFile), prepared.artifactPath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(prepared));
    }
  }
  await writeFile(path.join(store.runsDir, `${run.id}.json`), JSON.stringify(run));
}

/** Deliberately corrupt a listed retained fixture to exercise integrity refusals. */
export async function overwriteRetainedFixture(
  run: Run,
  relativePath: string,
  bytes: string | Uint8Array,
): Promise<void> {
  const { retainedRunTaskDirectory } = await import('../run-completion/retained-artifacts.js');
  const file = path.join(await retainedRunTaskDirectory(run), relativePath);
  await chmod(file, 0o600);
  await writeFile(file, bytes);
}
