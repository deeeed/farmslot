import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  Events,
  type SlotFixtureRefreshParams,
  type SlotFixtureRefreshResult,
} from '@farmslot/protocol';

import { farmslotRoot, loadSlotVars, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';

import { runPrepareCommand } from './prepare-command.js';
import type { EventEmitter } from './shared.js';

function buildFixtureSyncCommand(slotId: string, flowType?: string, selectedApp?: string): string {
  const syncArgs = ['--slot', slotId];
  if (flowType) syncArgs.push('--flow-type', flowType);
  if (selectedApp) syncArgs.push('--app', selectedApp);
  return `bash ${shellQuote(`${farmslotRoot}/scripts/sync-fixtures.sh`)} ${syncArgs.map(shellQuote).join(' ')}`;
}

export async function runFixtureSync(
  vars: SlotVars,
  opts: {
    slotId: string;
    logPath: string;
    signal?: AbortSignal;
    windowLabel?: string;
    phase: string;
    flowType?: string;
    selectedApp?: string;
  },
): Promise<void> {
  const syncCmd = buildFixtureSyncCommand(opts.slotId, opts.flowType, opts.selectedApp);
  const syncResult = await runPrepareCommand(vars, opts.logPath, syncCmd, {
    cwd: farmslotRoot,
    timeout: 180_000,
    signal: opts.signal,
    windowLabel: opts.windowLabel,
    phase: opts.phase,
    forceLocal: true,
  });
  if (syncResult.exitCode === 0) return;

  const err = new Error(`Fixture sync failed (exit ${syncResult.exitCode}) — log: ${opts.logPath}`);
  (err as Error & { failedCommand?: string; failedLogPath?: string }).failedCommand = syncCmd;
  (err as Error & { failedCommand?: string; failedLogPath?: string }).failedLogPath = opts.logPath;
  throw err;
}

export async function slotFixtureRefresh(
  params: SlotFixtureRefreshParams,
  emit: EventEmitter,
): Promise<SlotFixtureRefreshResult> {
  const vars = await loadSlotVars(params.slotId);
  const requestId = params.requestId ?? randomUUID();
  const startTime = Date.now();
  const logDir = path.join(farmslotRoot, '.farm-cache', 'fixture-refresh');
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `${params.slotId}-${requestId}.log`.replace(/[^A-Za-z0-9._-]/g, '-'),
  );
  const out = (line: string) =>
    emit(Events.SCRIPT_OUTPUT, {
      requestId,
      stream: 'stdout' as const,
      data: line.endsWith('\n') ? line : `${line}\n`,
      timestamp: Date.now(),
    });
  const complete = (exitCode: number, error?: string) =>
    emit(Events.SCRIPT_COMPLETE, {
      requestId,
      exitCode,
      duration: Date.now() - startTime,
      ...(error ? { error } : {}),
    });

  out(`[fixture-refresh] Syncing fixtures for ${params.slotId} (log: ${logPath})`);
  try {
    await runFixtureSync(vars, {
      slotId: params.slotId,
      logPath,
      windowLabel: requestId,
      phase: 'fixture-refresh',
      flowType: params.flowType,
      selectedApp: params.app,
    });
    out(`[fixture-refresh] Fixture refresh complete for ${params.slotId}`);
    complete(0);
    return { ok: true, requestId, logPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    complete(1, message);
    throw err;
  }
}

// ─── slotPrepare — native TS port of prepare-slot.sh ───
