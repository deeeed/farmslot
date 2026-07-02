import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  Events,
  type SlotFixtureRefreshParams,
  type SlotFixtureRefreshResult,
} from '@farmslot/protocol';

import { execLocal, farmslotRoot, isLocal, loadSlotVars, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';

import { runPrepareCommand } from './prepare-command.js';
import type { EventEmitter } from './shared.js';

export const LOCAL_FIXTURE_SYNC_TIMEOUT_MS = 60_000;
export const REMOTE_FIXTURE_SYNC_TIMEOUT_MS = 180_000;

function parseFixtureSyncTimeoutMs(raw: string | undefined): number | null {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveFixtureSyncTimeoutMs(vars: SlotVars): number {
  const envOverride = parseFixtureSyncTimeoutMs(process.env.FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS);
  if (envOverride) return envOverride;
  return isLocal(vars.host, vars.machine)
    ? LOCAL_FIXTURE_SYNC_TIMEOUT_MS
    : REMOTE_FIXTURE_SYNC_TIMEOUT_MS;
}

export function buildFixtureSyncCommand(
  slotId: string,
  flowType?: string,
  selectedApp?: string,
  team?: string,
): string {
  const syncArgs = ['--slot', slotId];
  if (flowType) syncArgs.push('--flow-type', flowType);
  if (selectedApp) syncArgs.push('--app', selectedApp);
  if (team) syncArgs.push('--team', team);
  return `bash ${shellQuote(`${farmslotRoot}/scripts/sync-fixtures.sh`)} ${syncArgs.map(shellQuote).join(' ')}`;
}

async function runFixtureSyncInline(
  syncCmd: string,
  logPath: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number }> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const startedAt = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const result = await execLocal(syncCmd, {
      cwd: farmslotRoot,
      timeout,
      signal: controller.signal,
    });
    const payload = [
      `[fixture-sync] inline local sync`,
      `command: ${syncCmd}`,
      `durationMs: ${Date.now() - startedAt}`,
      `exit: ${result.exitCode}`,
      '--- stdout ---',
      result.stdout,
      '--- stderr ---',
      result.stderr,
      '',
    ].join('\n');
    await appendFile(logPath, payload, 'utf-8');
    return { exitCode: result.exitCode };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
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
    team?: string;
  },
): Promise<void> {
  const syncCmd = buildFixtureSyncCommand(opts.slotId, opts.flowType, opts.selectedApp, opts.team);
  const timeout = resolveFixtureSyncTimeoutMs(vars);
  const slotIsLocal = isLocal(vars.host, vars.machine);
  const syncResult = slotIsLocal
    ? await runFixtureSyncInline(syncCmd, opts.logPath, timeout, opts.signal)
    : await runPrepareCommand(vars, opts.logPath, syncCmd, {
        cwd: farmslotRoot,
        timeout,
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
      team: params.team,
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
