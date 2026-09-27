import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRef, Run, RunDecision, RunOutput } from '@farmslot/protocol';

import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { refreshArtifactMirror } from './artifact-mirror.js';
import { scanArtifacts } from './publication-artifacts.js';

export function outputManifestDigest(artifacts: ArtifactRef[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...artifacts]
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
  if (
    prior.some(
      (decision) =>
        decision.payload?.kind === 'output-review' &&
        decision.payload.manifestDigest === output.manifestDigest &&
        (!decision.resolvedAt || decision.resolvedAction === 'mark-reviewed'),
    )
  )
    return decisions;
  for (const decision of prior) {
    if (!decision.resolvedAt) {
      decision.resolvedAt = new Date().toISOString();
      decision.resolvedAction = 'superseded';
    }
  }
  if (
    !output.workerFinished ||
    !output.reportPath ||
    output.captureError ||
    run.completionPolicy !== 'artifact-only' ||
    run.lane === 'comparison' ||
    run.engineState?.evalExperiment ||
    run.reviewWorkspace
  )
    return decisions;
  decisions.push({
    id: randomUUID(),
    type: 'engine_output_review',
    title: 'Review run output',
    description:
      'The worker has produced a report. Review its findings, gaps and evidence. Marking it reviewed does not approve a release, publish anything or change the worker outcome.',
    actions: [
      {
        id: 'mark-reviewed',
        label: 'Mark reviewed',
        style: 'primary',
        description:
          'Acknowledge this exact report and evidence snapshot. The recorded verdict stays unchanged.',
      },
    ],
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'output-review',
      manifestDigest: output.manifestDigest,
      reportPath: output.reportPath,
    },
  });
  return decisions;
}

/** Capture before completion policy can skip COMPLETE, including partial work. */
export async function captureRunOutput(
  runId: string,
  mirror = true,
  workerFinished = false,
): Promise<number> {
  const run = getRun(runId);
  if (!run?.taskFile || run.reviewWorkspace) return 0;
  const taskFile = run.taskFile;
  const generation = run.engineState?.generation;
  const copied = mirror ? await refreshArtifactMirror(run) : 0;
  const artifacts = await scanArtifacts(path.dirname(taskFile));
  if (artifacts.some((artifact) => !artifact.sha256))
    throw new Error('Could not fingerprint all output files');
  const report =
    artifacts.find((artifact) => artifact.path === 'artifacts/report.md') ??
    artifacts.find(
      (artifact) =>
        artifact.purpose === 'report' &&
        artifact.path.endsWith('.md') &&
        artifact.path.split('/').length === 2,
    );
  const output: RunOutput = {
    workerFinished:
      workerFinished ||
      (Boolean(run.output?.workerFinished) &&
        ['monitoring', 'paused', 'blocked', 'human-gating'].includes(run.status)) ||
      Boolean(run.completedAt) ||
      ['done', 'failed', 'cancelled'].includes(run.status),
    capturedAt: new Date().toISOString(),
    artifactManifest: artifacts,
    manifestDigest: outputManifestDigest(artifacts),
    ...(report ? { reportPath: report.path } : {}),
  };
  const current = getRun(runId);
  if (!current) return copied;
  if (current.taskFile !== taskFile || current.engineState?.generation !== generation)
    throw new Error('Run attempt changed while retrieving output; refresh the current attempt');
  const updated = updateRun(runId, {
    output,
    decisions:
      current.status === 'cancelled' ? current.decisions : outputReviewDecisions(current, output),
  });
  await persistRunNow(updated, 'retained run output');
  return copied;
}

export async function acknowledgeRunOutput(runId: string, decisionId: string): Promise<Run> {
  const run = getRun(runId);
  const decision = run?.decisions.find((candidate) => candidate.id === decisionId);
  if (
    !run?.taskFile ||
    !run.output ||
    decision?.payload?.kind !== 'output-review' ||
    decision.resolvedAt
  )
    throw new Error('Output review is no longer pending');
  const expected = decision.payload.manifestDigest;
  const reportPath = decision.payload.reportPath;
  if (
    path.isAbsolute(reportPath) ||
    reportPath.split(/[\\/]+/).some((segment) => segment === '..' || segment === '.')
  )
    throw new Error('Report path must stay inside retained output');
  if (run.output.captureError || run.output.manifestDigest !== expected)
    throw new Error('Run output changed; refresh the report before reviewing');
  // Verify the bytes, not just a previously stored manifest. New or removed files
  // also change the digest; a changed snapshot requires another review.
  const artifacts = await scanArtifacts(path.dirname(run.taskFile));
  if (outputManifestDigest(artifacts) !== expected)
    throw new Error('Run output changed; refresh the report before reviewing');
  if (!artifacts.some((artifact) => artifact.path === reportPath))
    throw new Error('Reviewed report is not in the retained output');
  const report = await readFile(path.join(path.dirname(run.taskFile), reportPath), 'utf8');
  if (!report.trim()) throw new Error('The report is empty');
  const current = getRun(runId);
  const pending = current?.decisions.find((candidate) => candidate.id === decisionId);
  if (!current || pending?.resolvedAt || current.output?.manifestDigest !== expected)
    throw new Error('Output review changed while it was being checked');
  const decisions = current.decisions.map((entry) =>
    entry.id === decisionId
      ? { ...entry, resolvedAt: new Date().toISOString(), resolvedAction: 'mark-reviewed' }
      : entry,
  );
  const updated = updateRun(runId, { decisions });
  await persistRunNow(updated, 'output review acknowledged');
  return updated;
}
