import { type DiffStat, FLOW_WORKER_REPORT_ARTIFACTS, type Run } from '@farmslot/protocol';

import { readOptionalRetainedRunText } from '../run-completion/retained-artifacts.js';
import { getAllRuns, getRun } from '../runs/store.js';

import { captureRunDiffArtifacts } from './diff-artifacts.js';

export async function readWorkerReport(runId: string): Promise<string | null> {
  const run = getRun(runId)!;
  const candidates = FLOW_WORKER_REPORT_ARTIFACTS[
    run.flowType as keyof typeof FLOW_WORKER_REPORT_ARTIFACTS
  ] ?? ['report.md', 'pr-description.md'];
  for (const filename of candidates) {
    const text = await readTaskArtifactText(run, filename);
    if (text?.trim()) return text;
  }
  return null;
}

export async function readTaskArtifactText(
  task: Run | string | null | undefined,
  filename: string,
): Promise<string | undefined> {
  if (!task) return undefined;
  const matching =
    typeof task === 'string' ? getAllRuns().filter((run) => run.taskFile === task) : [task];
  if (matching.length !== 1) return undefined;
  return readOptionalRetainedRunText(matching[0]!, `artifacts/${filename}`);
}

/** Same read, for `inputs/` — the task record rather than worker output. */
export async function readTaskInputText(
  taskFile: string | null | undefined,
  filename: string,
): Promise<string | undefined> {
  if (!taskFile) return undefined;
  const matching = getAllRuns().filter((run) => run.taskFile === taskFile);
  if (matching.length !== 1) return undefined;
  return readOptionalRetainedRunText(matching[0]!, `inputs/${filename}`);
}

export async function getDiffStat(run: Run, options: { fresh?: boolean } = {}): Promise<DiffStat> {
  const snapshot = await captureRunDiffArtifacts(run, {
    forceRecapture: options.fresh,
  });
  // COMPLETE step output keeps only the legacy numeric diffStat shape; full
  // provenance remains durable in artifacts/diff-stat.json and is re-read by
  // family observability for kind/filter/refs/SHAs/missing reasons.
  return { files: snapshot.files, additions: snapshot.additions, deletions: snapshot.deletions };
}
