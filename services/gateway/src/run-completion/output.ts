import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactRef,
  FLOW_WORKER_REPORT_ARTIFACTS,
  isTerminalRunStatus,
  PipelineSteps,
  RecordedEvidenceReadError,
  type Run,
  runClaimOverrideSnapshotIdentity,
  type RunDecision,
  type RunOutput,
  runOutputReviewEnabled,
  type RunStatus,
} from '@farmslot/protocol';

import { GATEWAY_OWNED_DIFF_ARTIFACTS } from '../core/artifact-copy-policy.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { type ArtifactMirrorOptions, refreshArtifactMirror } from './artifact-mirror.js';
import {
  publicationBaselineContext,
  resolvePublicationManifest,
  scanArtifacts,
} from './publication-artifacts.js';
import { writePublicationSelectionSnapshot } from './recorded-publication-evidence.js';
import {
  createRunArtifactAcquisition,
  readRetainedRunText,
  retainCapturedRunArtifacts,
  retainedRunArtifactManifest,
  retainedRunBundleRef,
} from './retained-artifacts.js';

// Completion writes these diagnostics after the worker output gate opens.
// Keep them browsable without changing the report and evidence being reviewed.
const OUTPUT_REVIEW_EXCLUDED_PATHS = new Set(
  GATEWAY_OWNED_DIFF_ARTIFACTS.map((name) => `artifacts/${name}`),
);

export function outputManifestDigest(artifacts: ArtifactRef[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...artifacts]
          .filter((artifact) => !OUTPUT_REVIEW_EXCLUDED_PATHS.has(artifact.path))
          .sort((a, b) => a.path.localeCompare(b.path))
          .map(({ path: file, sha256, sizeBytes }) => ({ path: file, sha256, sizeBytes })),
      ),
    )
    .digest('hex');
}

/** Only report-producing artifact runs request acknowledgement. Eval packages
 * and publication reviews keep their own existing decisions. */
export function outputReviewDecisions(run: Run, output: RunOutput): RunDecision[] {
  const decisions = structuredClone(run.decisions);
  const prior = decisions.filter((decision) => decision.payload?.kind === 'output-review');
  const sameCapture = (decision: RunDecision) =>
    decision.payload?.kind === 'output-review' &&
    decision.payload.manifestDigest === output.manifestDigest &&
    decision.payload.reportPath === output.reportPath;
  const eligible =
    !output.closedAt &&
    output.workerFinished &&
    output.reportPath &&
    !output.captureError &&
    runOutputReviewEnabled(run);
  if (
    eligible &&
    prior.some(
      (decision) =>
        sameCapture(decision) && (!decision.resolvedAt || decision.resolvedAction === 'close-run'),
    )
  )
    return decisions;
  for (const decision of prior) {
    if (!decision.resolvedAt) {
      decision.resolvedAt = new Date().toISOString();
      decision.resolvedAction = 'superseded';
    }
  }
  if (!eligible || !output.reportPath) return decisions;
  const reviewed = prior.some(
    (decision) => decision.resolvedAction === 'mark-reviewed' && sameCapture(decision),
  );
  const capturedReview = prior
    .slice()
    .reverse()
    .find((decision) => sameCapture(decision))?.payload;
  decisions.push({
    id: randomUUID(),
    type: 'engine_output_review',
    title: reviewed ? 'Close reviewed run output' : 'Review run output',
    description:
      'The worker has produced a report. Review its findings, gaps and evidence. Marking it reviewed does not approve a release, publish anything or change the worker outcome.',
    actions: [
      {
        id: 'close-run',
        label: 'Close run',
        style: 'primary',
        description:
          'Close finished execution and release its resources. Keep the recorded verdict and all coverage gaps; do not publish or approve a release.',
      },
      ...(!reviewed
        ? [
            {
              id: 'mark-reviewed',
              label: 'Mark reviewed',
              style: 'secondary' as const,
              description:
                'Acknowledge this exact report and evidence snapshot. The recorded verdict stays unchanged.',
            },
          ]
        : []),
    ],
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'output-review',
      ...(output.artifactBundle ? { artifactBundle: output.artifactBundle } : {}),
      manifestDigest: output.manifestDigest,
      reportPath: output.reportPath,
      ...(capturedReview?.kind === 'output-review'
        ? {
            ...(capturedReview.claimOverrideReceiptIds
              ? { claimOverrideReceiptIds: capturedReview.claimOverrideReceiptIds }
              : {}),
            ...(capturedReview.visualJudgmentReceiptIds
              ? { visualJudgmentReceiptIds: capturedReview.visualJudgmentReceiptIds }
              : {}),
          }
        : {}),
    },
  });
  return decisions;
}

/**
 * Statuses that can follow the worker's last turn: a capture there (a reviewer reading the
 * output, a refresh while a result decision waits) must not turn finished output back into
 * running output, unless the monitor is running again for a relaunched worker.
 */
const AFTER_WORKER_STATUSES: readonly RunStatus[] = [
  'monitoring',
  'paused',
  'blocked',
  'reviewing',
  'needs-decision',
  'human-gating',
  'completing',
];

/** The current monitor step is watching a worker: not started yet, or relaunched. */
function monitorActive(run: Run): boolean {
  const status = run.steps.find((step) => step.name === PipelineSteps.MONITOR)?.status;
  return status === 'pending' || status === 'running';
}

/** The current monitor step ended on the worker's own completion signal. */
function monitorSawWorkerFinish(run: Run): boolean {
  const monitor = run.steps.find((step) => step.name === PipelineSteps.MONITOR);
  const signal = monitor?.outputs?.workerSignal;
  const status =
    signal && typeof signal === 'object' ? (signal as { status?: unknown }).status : undefined;
  return monitor?.status === 'done' && (status === 'complete' || status === 'done');
}

function outputWorkerFinished(run: Run, workerFinished: boolean): boolean {
  return (
    workerFinished ||
    (AFTER_WORKER_STATUSES.includes(run.status) &&
      !monitorActive(run) &&
      (Boolean(run.output?.workerFinished) || monitorSawWorkerFinish(run))) ||
    Boolean(run.completedAt) ||
    isTerminalRunStatus(run.status)
  );
}

/** Keep retained files readable, but retire a review of an invalid snapshot. */
export function failRunOutputCapture(runId: string, error: unknown, workerFinished = false): Run {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const output: RunOutput = {
    workerFinished: outputWorkerFinished(run, workerFinished),
    capturedAt: new Date().toISOString(),
    ...(run.output?.closedAt
      ? {
          closedAt: run.output.closedAt,
          closeError: run.output.closeError,
          cleanupPending: run.output.cleanupPending,
        }
      : {}),
    artifactManifest: run.output?.artifactManifest ?? [],
    manifestDigest: run.output?.manifestDigest ?? '',
    reportPath: run.output?.reportPath,
    ...(run.output?.artifactBundle ? { artifactBundle: run.output.artifactBundle } : {}),
    captureError: error instanceof Error ? error.message : String(error),
  };
  return updateRun(runId, { output, decisions: outputReviewDecisions(run, output) });
}

/** Capture before completion policy can skip COMPLETE, including partial work. */
export async function captureRunOutput(
  runId: string,
  mirror = true,
  workerFinished = false,
  options: ArtifactMirrorOptions = {},
): Promise<number> {
  const run = getRun(runId);
  if (!run?.taskFile) return 0;
  const taskFile = run.taskFile;
  const generation = run.engineState?.generation;
  const acquisition = options.acquisition ?? createRunArtifactAcquisition(run);
  const copied =
    mirror && !run.reviewWorkspace
      ? await refreshArtifactMirror(run, { ...options, acquisition })
      : 0;
  const artifactsByPath = new Map(
    [...(await scanArtifacts(path.dirname(taskFile))), ...acquisition.media].map((artifact) => [
      artifact.path,
      artifact,
    ]),
  );
  if (workerFinished || options.forPublication) {
    let selection: Awaited<ReturnType<typeof resolvePublicationManifest>> = null;
    try {
      selection = await resolvePublicationManifest(
        path.dirname(taskFile),
        undefined,
        undefined,
        run.recordedEvidenceContractVersion ?? 0,
        publicationBaselineContext(run, [...artifactsByPath.values()]),
      );
    } catch (error) {
      if (!(error instanceof RecordedEvidenceReadError)) throw error;
      // A failed recipe still owns its raw report and diagnostics. The publication
      // gate revalidates this metadata and refuses it before any publication.
      console.warn(
        `[output] Retaining raw output without a publication selection: ${error.message}`,
      );
    }
    if (selection) {
      const snapshot = await writePublicationSelectionSnapshot(
        path.dirname(taskFile),
        selection.manifest,
      );
      artifactsByPath.set(snapshot.path, snapshot);
    }
  }
  const artifacts = [...artifactsByPath.values()];
  if (artifacts.some((artifact) => !artifact.sha256))
    throw new Error('Could not fingerprint all output files');
  const candidates = [
    ...(FLOW_WORKER_REPORT_ARTIFACTS[run.flowType] ?? ['report.md']).map((name) =>
      artifacts.find((artifact) => artifact.path === `artifacts/${name.replace(/\.md$/, '.html')}`),
    ),
    ...(FLOW_WORKER_REPORT_ARTIFACTS[run.flowType] ?? ['report.md']).map((name) =>
      artifacts.find((artifact) => artifact.path === `artifacts/${name}`),
    ),
    ...artifacts.filter(
      (artifact) =>
        artifact.purpose === 'report' &&
        artifact.path.endsWith('.md') &&
        artifact.path.split('/').length === 2,
    ),
  ];
  let report: ArtifactRef | undefined;
  for (const candidate of candidates) {
    if (
      candidate &&
      (await readFile(path.join(path.dirname(taskFile), candidate.path), 'utf8')).trim()
    ) {
      report = candidate;
      break;
    }
  }
  const current = getRun(runId);
  if (!current) return copied;
  if (current.taskFile !== taskFile || current.engineState?.generation !== generation)
    throw new Error('Run attempt changed while retrieving output; refresh the current attempt');
  const output: RunOutput = {
    workerFinished: outputWorkerFinished(current, workerFinished),
    ...(current.output?.closedAt
      ? {
          closedAt: current.output.closedAt,
          closeError: current.output.closeError,
          cleanupPending: current.output.cleanupPending,
        }
      : {}),
    capturedAt: new Date().toISOString(),
    artifactManifest: artifacts,
    manifestDigest: outputManifestDigest(artifacts),
    ...(report ? { reportPath: report.path } : {}),
  };
  const retained = await retainCapturedRunArtifacts({
    run: { ...current, output },
    artifacts,
    acquireMedia: acquisition.acquireMedia,
    manifestDigest: output.manifestDigest,
    releaseStagingMedia: true,
    commit: async (ref, missingData) => {
      const latest = getRun(runId);
      if (!latest || latest.taskFile !== taskFile || latest.engineState?.generation !== generation)
        throw new Error('Run attempt changed while retaining output; refresh the current attempt');
      const retainedOutput: RunOutput = {
        ...output,
        artifactBundle: ref,
        retentionMissingData: missingData,
      };
      const updated = updateRun(runId, {
        artifactBundle: ref,
        output: retainedOutput,
        decisions:
          latest.status === 'cancelled'
            ? latest.decisions
            : outputReviewDecisions(latest, retainedOutput),
      });
      await persistRunNow(updated, 'retained run output');
    },
  });
  console.info(
    `[output] ${runId} acquisition scan: files=${retained.acquisitionScan.fileCount} settledDirs=${retained.acquisitionScan.settledDirs} durationMs=${retained.acquisitionScan.durationMs.toFixed(1)}`,
  );
  return copied;
}

export async function verifyRunOutputReview(
  runId: string,
  decisionId: string,
  allowReviewed = false,
  expectedOverrideSnapshot?: string,
): Promise<Run> {
  const run = getRun(runId);
  const decision = run?.decisions.find((candidate) => candidate.id === decisionId);
  if (
    !run?.taskFile ||
    !run.output ||
    decision?.payload?.kind !== 'output-review' ||
    (decision.resolvedAt &&
      !(allowReviewed && ['mark-reviewed', 'close-run'].includes(decision.resolvedAction ?? '')))
  )
    throw new Error('Output review is no longer pending');
  const taskFile = run.taskFile;
  const generation = run.engineState?.generation;
  const expected = decision.payload.manifestDigest;
  const overrideSnapshot = expectedOverrideSnapshot ?? runClaimOverrideSnapshotIdentity(decision);
  assertOutputOverrideSnapshot(run, decisionId, overrideSnapshot);
  const reportPath = decision.payload.reportPath;
  if (
    path.isAbsolute(reportPath) ||
    reportPath.split(/[\\/]+/).some((segment) => segment === '..' || segment === '.')
  )
    throw new Error('Report path must stay inside retained output');
  if (
    run.output.captureError ||
    run.output.manifestDigest !== expected ||
    run.output.reportPath !== reportPath
  )
    throw new Error('Run output changed; refresh the report before reviewing');
  // The decision reads its immutable capture, never the mutable acquisition mirror.
  const ref = retainedRunBundleRef(run, decisionId);
  const artifacts = (await retainedRunArtifactManifest(run, ref)).filter((artifact) =>
    artifact.path.startsWith('artifacts/'),
  );
  if (outputManifestDigest(artifacts) !== expected)
    throw new Error('Run output changed; refresh the report before reviewing');
  if (!artifacts.some((artifact) => artifact.path === reportPath))
    throw new Error('Reviewed report is not in the retained output');
  const report = await readRetainedRunText(run, reportPath, ref);
  if (!report.trim()) throw new Error('The report is empty');
  const current = getRun(runId);
  const pending = current?.decisions.find((candidate) => candidate.id === decisionId);
  if (
    !current ||
    !pending ||
    (pending.resolvedAt &&
      !(allowReviewed && ['mark-reviewed', 'close-run'].includes(pending.resolvedAction ?? ''))) ||
    current.output?.captureError ||
    current.output?.manifestDigest !== expected ||
    current.output?.reportPath !== reportPath ||
    pending.payload?.kind !== 'output-review' ||
    pending.payload.manifestDigest !== expected ||
    pending.payload.reportPath !== reportPath ||
    current.taskFile !== taskFile ||
    current.engineState?.generation !== generation
  )
    throw new Error('Output review changed while it was being checked');
  assertOutputOverrideSnapshot(current, decisionId, overrideSnapshot);
  return current;
}

export function assertOutputOverrideSnapshot(run: Run, decisionId: string, expected: string): void {
  const decision = run.decisions.find((entry) => entry.id === decisionId);
  if (!decision || runClaimOverrideSnapshotIdentity(decision) !== expected)
    throw new Error(
      'The claim override review changed. Refresh and confirm the current output snapshot.',
    );
}

export function outputOverrideSnapshot(runId: string, decisionId: string): string {
  const decision = getRun(runId)?.decisions.find((entry) => entry.id === decisionId);
  if (decision?.payload?.kind !== 'output-review') throw new Error('Output review is unavailable');
  return runClaimOverrideSnapshotIdentity(decision);
}

export async function acknowledgeRunOutput(
  runId: string,
  decisionId: string,
  expectedOverrideSnapshot?: string,
): Promise<Run> {
  const expected = expectedOverrideSnapshot ?? outputOverrideSnapshot(runId, decisionId);
  const current = await verifyRunOutputReview(runId, decisionId, false, expected);
  assertOutputOverrideSnapshot(current, decisionId, expected);
  const decisions = current.decisions.map((entry) =>
    entry.id === decisionId
      ? { ...entry, resolvedAt: new Date().toISOString(), resolvedAction: 'mark-reviewed' }
      : entry,
  );
  const updated = updateRun(runId, {
    decisions: outputReviewDecisions({ ...current, decisions }, current.output!),
  });
  await persistRunNow(updated, 'output review acknowledged');
  return updated;
}
