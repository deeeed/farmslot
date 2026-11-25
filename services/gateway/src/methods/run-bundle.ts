import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  RunBundleExportParams,
  RunBundleExportResult,
  RunBundleImportParams,
  RunBundleImportResult,
  RunBundleListParams,
  RunBundleListResult,
} from '@farmslot/protocol';
import {
  exportRunsToBundle,
  importBundle,
  listBundle,
  runBundleRetentionSettings,
} from '@farmslot/run-bundle';

import { assertHeavyWriteRoom, assertHeavyWriteRootPresent } from '../core/heavy-write-room.js';
import { farmslotRoot } from '../projects/repo-root.js';
import { runBundleHome, runBundleStoreRoot } from '../run-completion/retained-artifacts.js';
import { captureRunEpisode } from '../run-completion/run-episode.js';
import { getRun, loadAllRuns, runsDirectory } from '../runs/store.js';

export async function runBundleExport(
  params: RunBundleExportParams,
): Promise<RunBundleExportResult> {
  if (!params.outputPath?.trim())
    throw new Error('Invalid run.bundle.export params: missing outputPath');
  // Export stages the retained media in the temp directory before writing the bundle.
  for (const dir of [tmpdir(), path.dirname(path.resolve(params.outputPath))])
    await assertHeavyWriteRoom(dir);
  return exportRunsToBundle({
    farmslotRoot: farmslotRoot(),
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
  // An import extracts in the temp directory, restores task payloads under the checkout, and
  // writes run records and their media into the gateway's stores. Each may be its own volume.
  const configured = runBundleRetentionSettings(runBundleHome()).storeRoot;
  if (configured) await assertHeavyWriteRootPresent(configured, 'runBundleRetention.storeRoot');
  // The store root the store itself opens; on layout 2 that is the data root's volume.
  for (const dir of [tmpdir(), farmslotRoot(), runsDirectory(), runBundleStoreRoot()])
    await assertHeavyWriteRoom(dir);
  const result = await importBundle({
    farmslotRoot: farmslotRoot(),
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
/** ADR-039 Amendment 10: retain retries every session not yet captured while its node holds it. */
async function retainRunnerSessions(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run?.slotId) return;
  const { tracesEnabled } = await import('../run-traces/session-capture.js');
  if (!(await tracesEnabled(run.project))) return;
  try {
    const { loadSlotVars } = await import('../core/config.js');
    const { captureAllRunnerSessions } = await import('../runners/session-archive.js');
    await captureAllRunnerSessions({ vars: await loadSlotVars(run.slotId), runId });
  } catch (error) {
    console.warn(`[session-archive] ${runId}: retain capture failed: ${(error as Error).message}`);
  }
}

export async function runBundleRetain(
  params: import('@farmslot/protocol').RunBundleRetainParams,
): Promise<import('@farmslot/protocol').RunBundleRetainResult> {
  if (!params.runId?.trim()) throw new Error('Invalid run.bundle.retain params: missing runId');
  const { retainRunArtifacts } = await import('../run-completion/retained-artifacts.js');
  await retainRunnerSessions(params.runId);
  const result = await retainRunArtifacts(params.runId);
  const { recordCompletionAcceptance } = await import('../run-traces/output.js');
  await recordCompletionAcceptance(params.runId);
  // ADR-039 Amendment 4 backfill: an ended run's episode picks up the digests just retained.
  // Advisory like every episode write: the retain itself succeeded and stays reported as such.
  const run = getRun(params.runId);
  if (run)
    await captureRunEpisode(run).catch((error) =>
      console.warn(
        `[run-episode] ${run.id}: refresh after retain failed: ${(error as Error).message}`,
      ),
    );
  return result;
}
