import type {
  RunBundleExportParams,
  RunBundleExportResult,
  RunBundleImportParams,
  RunBundleImportResult,
  RunBundleListParams,
  RunBundleListResult,
} from '@farmslot/protocol';
import { exportRunsToBundle, importBundle, listBundle } from '@farmslot/run-bundle';

import { farmslotRoot } from '../projects/repo-root.js';
import { captureRunEpisode } from '../run-completion/run-episode.js';
import { getRun, loadAllRuns } from '../runs/store.js';

export async function runBundleExport(
  params: RunBundleExportParams,
): Promise<RunBundleExportResult> {
  if (!params.outputPath?.trim())
    throw new Error('Invalid run.bundle.export params: missing outputPath');
  return exportRunsToBundle({
    farmslotRoot,
    outputPath: params.outputPath,
    profile: params.profile ?? 'reference',
    familyId: params.familyId,
    positionalRunId: params.runId,
    runIds: params.runIds ?? undefined,
    gatewayUrl: process.env.GATEWAY_URL,
  });
}

export async function runBundleImport(
  params: RunBundleImportParams,
): Promise<RunBundleImportResult> {
  if (!params.bundlePath?.trim())
    throw new Error('Invalid run.bundle.import params: missing bundlePath');
  const result = await importBundle({
    farmslotRoot,
    bundlePath: params.bundlePath,
    mode: params.mode ?? 'seed',
    force: params.force,
  });
  await loadAllRuns();
  return result;
}

export function runBundleList(params: RunBundleListParams): RunBundleListResult {
  if (!params.bundlePath?.trim())
    throw new Error('Invalid run.bundle.list params: missing bundlePath');
  return { manifest: listBundle(params.bundlePath) };
}
export async function runBundleRetain(
  params: import('@farmslot/protocol').RunBundleRetainParams,
): Promise<import('@farmslot/protocol').RunBundleRetainResult> {
  if (!params.runId?.trim()) throw new Error('Invalid run.bundle.retain params: missing runId');
  const { retainRunArtifacts } = await import('../run-completion/retained-artifacts.js');
  const result = await retainRunArtifacts(params.runId);
  // ADR-039 Amendment 4 backfill: an ended run's episode picks up the digests just retained.
  const run = getRun(params.runId);
  if (run) await captureRunEpisode(run);
  return result;
}
