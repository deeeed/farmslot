import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { type DiffStat, FLOW_WORKER_REPORT_ARTIFACTS, type Run } from '@farmslot/protocol';

import { getRun } from '../runs/store.js';

import { captureRunDiffArtifacts } from './diff-artifacts.js';

export async function readWorkerReport(runId: string): Promise<string | null> {
  const run = getRun(runId)!;
  const candidates = FLOW_WORKER_REPORT_ARTIFACTS[
    run.flowType as keyof typeof FLOW_WORKER_REPORT_ARTIFACTS
  ] ?? ['report.md', 'pr-description.md'];
  for (const filename of candidates) {
    const text = await readTaskArtifactText(run.taskFile, filename);
    if (text?.trim()) return text;
  }
  return null;
}

export async function readTaskArtifactText(
  taskFile: string | null | undefined,
  filename: string,
): Promise<string | undefined> {
  if (!taskFile) return undefined;
  const artifactPath = path.join(path.dirname(taskFile), 'artifacts', filename);
  if (!existsSync(artifactPath)) return undefined;
  try {
    return await readFile(artifactPath, 'utf-8');
  } catch (err) {
    // Individual optional artifacts are recoverable, but the read failure
    // should remain visible because it changes review/gate evidence.
    console.warn(
      `[run-engine] failed to read task artifact ${artifactPath}: ${(err as Error).message.slice(0, 200)}`,
    );
    return undefined;
  }
}

export async function getDiffStat(run: Run): Promise<DiffStat> {
  const snapshot = await captureRunDiffArtifacts(run);
  // COMPLETE step output keeps only the legacy numeric diffStat shape; full
  // provenance remains durable in artifacts/diff-stat.json and is re-read by
  // family observability for kind/filter/refs/SHAs/missing reasons.
  return { files: snapshot.files, additions: snapshot.additions, deletions: snapshot.deletions };
}
