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
import type { EventEmitter, PrepareCommandError } from './shared.js';

// Backstops against a hung sync-fixtures.sh — not a pacing budget. A real local
// sync of one domain runs 55-60s on a fast dev machine, so the old 60s local
// limit killed healthy runs (exit 124) with every file already [OK]. Keep the
// limit well clear of normal runtime; slow machines override via the env var below.
export const LOCAL_FIXTURE_SYNC_TIMEOUT_MS = 300_000;
export const REMOTE_FIXTURE_SYNC_TIMEOUT_MS = 180_000;

/** Override for {@link resolveFixtureSyncTimeoutMs}; surfaced in the timeout error. */
export const FIXTURE_SYNC_TIMEOUT_ENV_VAR = 'FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS';

// execLocal reports a killed-by-timeout run as exit 124 (see core/exec.ts).
const TIMEOUT_EXIT_CODE = 124;

function parseFixtureSyncTimeoutMs(raw: string | undefined): number | null {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveFixtureSyncTimeoutMs(vars: SlotVars): number {
  const envOverride = parseFixtureSyncTimeoutMs(process.env[FIXTURE_SYNC_TIMEOUT_ENV_VAR]);
  if (envOverride) return envOverride;
  return isLocal(vars.host, vars.machine)
    ? LOCAL_FIXTURE_SYNC_TIMEOUT_MS
    : REMOTE_FIXTURE_SYNC_TIMEOUT_MS;
}

/**
 * Teach the escape when the sync-fixtures backstop fires (repo invariant: every
 * error carries the caller's actual next step). The kill is a backstop, not a
 * verdict — the log usually shows every file already [OK].
 */
export function buildFixtureSyncTimeoutMessage(opts: {
  slotId: string;
  elapsedMs: number;
  timeoutMs: number;
  logPath: string;
  envFilePath: string;
  prepareProfile?: string;
}): string {
  const profileFlag = ` --prepare-profile ${opts.prepareProfile ?? '<profile>'}`;
  const rerun = `farmslot slot prepare ${opts.slotId}${profileFlag}`;
  return [
    `Fixture sync timed out after ${opts.elapsedMs}ms (backstop ${opts.timeoutMs}ms) for slot ${opts.slotId} — log: ${opts.logPath}`,
    `The ${opts.timeoutMs}ms limit is a hung-process backstop, not a failure: check the log — files are often already [OK].`,
    `Next: re-run prepare for this slot: ${rerun}`,
    // The backstop resolves inside the already-running gateway, which loads this
    // var from .env at startup (see gateway index.ts). A CLI-side env prefix
    // never reaches it, so the escape must edit the gateway's .env and restart.
    `If this machine is consistently slow, raise the backstop in the gateway env (a CLI-side ${FIXTURE_SYNC_TIMEOUT_ENV_VAR}=... is ignored — the running gateway reads it from .env at startup): add ${FIXTURE_SYNC_TIMEOUT_ENV_VAR}=<ms> to ${opts.envFilePath}, then restart the gateway: farmslot down && farmslot up`,
  ].join('\n');
}

export function buildFixtureSyncCommand(
  slotId: string,
  flowType?: string,
  selectedApp?: string,
  domain?: string,
): string {
  const syncArgs = ['--slot', slotId];
  if (flowType) syncArgs.push('--flow-type', flowType);
  if (selectedApp) syncArgs.push('--app', selectedApp);
  if (domain) syncArgs.push('--domain', domain);
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
    domain?: string;
    prepareProfile?: string;
  },
): Promise<void> {
  const syncCmd = buildFixtureSyncCommand(
    opts.slotId,
    opts.flowType,
    opts.selectedApp,
    opts.domain,
  );
  const timeout = resolveFixtureSyncTimeoutMs(vars);
  const slotIsLocal = isLocal(vars.host, vars.machine);
  const startedAt = Date.now();
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

  const message =
    syncResult.exitCode === TIMEOUT_EXIT_CODE
      ? buildFixtureSyncTimeoutMessage({
          slotId: opts.slotId,
          elapsedMs: Date.now() - startedAt,
          timeoutMs: timeout,
          logPath: opts.logPath,
          envFilePath: path.join(farmslotRoot, '.env'),
          prepareProfile: opts.prepareProfile,
        })
      : `Fixture sync failed (exit ${syncResult.exitCode}) — log: ${opts.logPath}`;
  const err = new Error(message) as PrepareCommandError;
  err.failedCommand = syncCmd;
  err.failedLogPath = opts.logPath;
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
      domain: params.domain ?? vars.domain,
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
