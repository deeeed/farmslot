import type { loadSlotVars } from '../core/config.js';
import { execOnSlot, type ExecResult } from '../core/exec.js';
import { resolveTmuxPaneId, shellQuote } from '../core/tmux.js';
import { normalizeWorkerSignal } from '../tasks/worker-signals.js';

import {
  deriveRunnerActivity,
  filterHooksByPane,
  parseHookJsonl,
  promptAcceptedFromHooks,
  promptDigestMatchedFromHooks,
  promptTurnStartedFromHooks,
  readRunnerObservabilityFiles,
  runnerActivityIsBusy,
} from './observability-files.js';
import { runnerPromptDigest } from './observability-prompt-digest.js';
import { isObservabilityReadingAuthoritative } from './observability-send-decision.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export interface RunnerHandoffAckProbe {
  accepted: boolean;
  reason: string;
  source?:
    | 'hook-digest'
    | 'hook-turn'
    | 'hook-activity'
    | 'launch-signal'
    | 'native-signal'
    | 'pane';
}

export interface LaunchAckSignalSnapshot {
  raw: string | null;
  status: string | null;
  mtimeNs: string;
}

const MISSING_SIGNAL = '__FARMSLOT_SIGNAL_MISSING__';
const UNREADABLE_SIGNAL = '__FARMSLOT_SIGNAL_UNREADABLE__';

export function buildLaunchAckSignalReadCommand(signalPath: string): string {
  const quotedPath = shellQuote(signalPath);
  // Portable stat fallbacks are second-resolution. Identical rewrites inside
  // one second therefore fail closed rather than inventing timestamp precision.
  return [
    `if [ ! -f ${quotedPath} ]; then`,
    `  printf '${MISSING_SIGNAL}\\n'`,
    'else',
    "  mtime=''",
    '  if command -v python3 >/dev/null 2>&1; then',
    `    mtime=$(python3 -c 'import os, sys; print(os.stat(sys.argv[1]).st_mtime_ns)' ${quotedPath}) || mtime=''`,
    '  fi',
    `  if [ -z "$mtime" ] && stat -f '%m' ${quotedPath} >/dev/null 2>&1; then`,
    `    mtime=$(stat -f '%m' ${quotedPath})000000000`,
    `  elif [ -z "$mtime" ] && stat -c '%Y' ${quotedPath} >/dev/null 2>&1; then`,
    `    mtime=$(stat -c '%Y' ${quotedPath})000000000`,
    '  fi',
    '  if [ -z "$mtime" ]; then',
    `    printf '${UNREADABLE_SIGNAL}\\n'`,
    '  else',
    '    printf \'%s\\n\' "$mtime"',
    `    cat ${quotedPath}`,
    '  fi',
    'fi',
  ].join('\n');
}

export async function readLaunchAckSignalSnapshot(
  vars: SlotVars,
  signalPath: string,
): Promise<LaunchAckSignalSnapshot | null> {
  let result: ExecResult;
  try {
    result = await execOnSlot(vars, buildLaunchAckSignalReadCommand(signalPath), vars.remoteRepo);
  } catch (error) {
    // This probe is corroborating evidence. Transport failure must fall back to
    // runner-native hooks/session logs and pane verification, not fail dispatch.
    console.warn(
      `[runner-observability] launch acknowledgement probe failed for ${vars.slotId}: ${(error as Error).message}`,
    );
    return null;
  }
  if (result.exitCode !== 0) {
    console.warn(
      `[runner-observability] launch acknowledgement probe failed for ${vars.slotId}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
    return null;
  }
  if (result.stdout.startsWith(MISSING_SIGNAL)) {
    return { raw: null, status: null, mtimeNs: '0' };
  }
  if (result.stdout.startsWith(UNREADABLE_SIGNAL)) return null;
  const newline = result.stdout.indexOf('\n');
  if (newline < 0) {
    console.warn(
      `[runner-observability] launch acknowledgement probe returned no stat line for ${vars.slotId}`,
    );
    return null;
  }
  const mtimeNs = result.stdout.slice(0, newline).trim();
  if (!/^\d+$/.test(mtimeNs)) {
    console.warn(
      `[runner-observability] launch acknowledgement probe returned invalid mtime for ${vars.slotId}`,
    );
    return null;
  }
  const raw = result.stdout.slice(newline + 1).trim();
  if (!raw) return { raw, status: null, mtimeNs };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      // SIGNAL.json can be observed between truncate and rename/write completion.
      return { raw, status: null, mtimeNs };
    }
    throw error;
  }
  const normalized = normalizeWorkerSignal(parsed);
  return {
    raw,
    status: normalized.ok ? normalized.signal.status : null,
    mtimeNs,
  };
}

export function launchAckSignalAdvanced(
  baseline: LaunchAckSignalSnapshot | null | undefined,
  current: LaunchAckSignalSnapshot,
): boolean {
  if (!baseline || current.status === null) return false;
  return current.raw !== baseline.raw || current.mtimeNs !== baseline.mtimeNs;
}

export async function probeRunnerHandoffAck(
  vars: SlotVars,
  target: string,
  message: string,
  sinceMs: number,
  opts: {
    paneId?: string | null;
    launchAckSignalPath?: string | null;
    launchAckBaseline?: LaunchAckSignalSnapshot | null;
    preferHooks?: boolean;
    requirePromptDigest?: boolean;
  } = {},
): Promise<RunnerHandoffAckProbe> {
  if (opts.launchAckSignalPath && opts.launchAckBaseline && !opts.requirePromptDigest) {
    const launchAck = await readLaunchAckSignalSnapshot(vars, opts.launchAckSignalPath);
    if (launchAck && launchAckSignalAdvanced(opts.launchAckBaseline, launchAck)) {
      return {
        accepted: true,
        reason: `launch ack signal advanced to ${launchAck.status} at ${opts.launchAckSignalPath}`,
        source: 'launch-signal',
      };
    }
  }

  if (opts.preferHooks === false) {
    return { accepted: false, reason: 'hook handoff disabled for runner' };
  }

  const paneId = opts.paneId ?? (await resolveTmuxPaneId(vars, target));
  const { hooksRaw } = await readRunnerObservabilityFiles(vars);
  const hooks = parseHookJsonl(hooksRaw);
  const digest = runnerPromptDigest(message);
  const digestMatched = promptDigestMatchedFromHooks(hooks, digest, sinceMs, paneId);

  if (opts.requirePromptDigest) {
    return digestMatched
      ? {
          accepted: true,
          reason: paneId
            ? `hook prompt digest matched on pane ${paneId}`
            : 'hook prompt digest matched',
          source: 'hook-digest',
        }
      : { accepted: false, reason: 'prompt digest did not match handoff evidence' };
  }

  const digestReading = promptAcceptedFromHooks(hooks, digest, sinceMs, 500, Date.now(), paneId);
  if (isObservabilityReadingAuthoritative(digestReading) && digestReading.value === true) {
    return {
      accepted: true,
      reason: digestMatched
        ? paneId
          ? `hook prompt digest matched on pane ${paneId}`
          : 'hook prompt digest matched'
        : paneId
          ? `hook turn started on pane ${paneId}`
          : 'hook turn started after prompt send',
      source: digestMatched ? 'hook-digest' : 'hook-turn',
    };
  }

  const turnReading = promptTurnStartedFromHooks(hooks, sinceMs, paneId);
  if (isObservabilityReadingAuthoritative(turnReading) && turnReading.value === true) {
    return {
      accepted: true,
      reason: paneId
        ? `hook turn started on pane ${paneId}`
        : 'hook turn started after prompt send',
      source: 'hook-turn',
    };
  }

  const scopedHooks = filterHooksByPane(hooks, paneId);
  const activity = deriveRunnerActivity(scopedHooks, null);
  if (
    activity &&
    isObservabilityReadingAuthoritative(activity) &&
    activity.observedAt >= sinceMs &&
    runnerActivityIsBusy(activity.value)
  ) {
    return {
      accepted: true,
      reason: `hook activity ${activity.value} after prompt send`,
      source: 'hook-activity',
    };
  }

  return { accepted: false, reason: 'no hook or launch-signal handoff evidence' };
}
