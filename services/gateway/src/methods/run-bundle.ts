import { exportRunsToBundle, importBundle, listBundle } from '@farmslot/run-bundle';
import type {
  RunBundleExportParams,
  RunBundleExportResult,
  RunBundleImportParams,
  RunBundleImportResult,
  RunBundleListParams,
  RunBundleListResult,
} from '@farmslot/protocol';

import { farmslotRoot } from '../projects/repo-root.js';
import { loadAllRuns } from '../runs/store.js';

export async function runBundleExport(params: RunBundleExportParams): Promise<RunBundleExportResult> {
  if (!params.outputPath?.trim()) throw new Error('Invalid run.bundle.export params: missing outputPath');
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

export async function runBundleImport(params: RunBundleImportParams): Promise<RunBundleImportResult> {
  if (!params.bundlePath?.trim()) throw new Error('Invalid run.bundle.import params: missing bundlePath');
  const result = importBundle({
    farmslotRoot,
    bundlePath: params.bundlePath,
    mode: params.mode ?? 'reference-only',
    force: params.force,
  });
  await loadAllRuns();
  return result;
}

export function runBundleList(params: RunBundleListParams): RunBundleListResult {
  if (!params.bundlePath?.trim()) throw new Error('Invalid run.bundle.list params: missing bundlePath');
  return { manifest: listBundle(params.bundlePath) };
}