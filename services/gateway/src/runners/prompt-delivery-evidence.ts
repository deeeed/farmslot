import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { resolveTmuxPaneId, shellQuote } from '../core/tmux.js';
import { normalizeWorkerSignal } from '../tasks/worker-signals.js';

import {
  deriveRunnerActivity,
  filterHooksByPane,
  parseHookJsonl,
  promptAcceptedFromHooks,
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
  source?: 'hook-digest' | 'hook-turn' | 'hook-activity' | 'launch-signal' | 'pane';
}

export interface LaunchAckSignalSnapshot {
  raw: string | null;
  status: string | null;
  mtimeNs: string;
}

const MISSING_SIGNAL = '__FARMSLOT_SIGNAL_MISSING__';

export function buildLaunchAckSignalReadCommand(signalPath: string): string {
  const quotedPath = shellQuote(signalPath);
  return `if [ ! -f ${quotedPath} ]; then printf '${MISSING_SIGNAL}\\n'; else mtime_ns=$(python3 -c 'import os, sys; print(os.stat(sys.argv[1]).st_mtime_ns)' ${quotedPath}) || exit 1; printf '%s\\n' "$mtime_ns"; cat ${quotedPath}; fi`;
}

export async function readLaunchAckSignalSnapshot(
  vars: SlotVars,
  signalPath: string,
): Promise<LaunchAckSignalSnapshot> {
  const result = await execOnSlot(
    vars,
    buildLaunchAckSignalReadCommand(signalPath),
    vars.remoteRepo,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to read launch acknowledgement signal ${signalPath}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  if (result.stdout.startsWith(MISSING_SIGNAL)) {
    return { raw: null, status: null, mtimeNs: '0' };
  }
  const newline = result.stdout.indexOf('\n');
  if (newline < 0) {
    throw new Error(`Launch acknowledgement signal probe returned no stat line: ${signalPath}`);
  }
  const mtimeNs = result.stdout.slice(0, newline).trim();
  if (!/^\d+$/.test(mtimeNs)) {
    throw new Error(`Launch acknowledgement signal probe returned invalid mtime: ${signalPath}`);
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
  _sinceMs: number,
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
  if (opts.launchAckSignalPath) {
    const launchAck = await readLaunchAckSignalSnapshot(vars, opts.launchAckSignalPath);
    if (launchAckSignalAdvanced(opts.launchAckBaseline, launchAck, sinceMs)) {
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

  const digestReading = promptAcceptedFromHooks(hooks, digest, sinceMs, 500, Date.now(), paneId);
  if (isObservabilityReadingAuthoritative(digestReading) && digestReading.value === true) {
    return {
      accepted: true,
      reason: paneId
        ? `hook prompt digest matched on pane ${paneId}`
        : 'hook prompt digest matched',
      source: digestReading.confidence === 'high' ? 'hook-digest' : 'hook-turn',
    };
  }
  if (opts.requirePromptDigest) {
    return { accepted: false, reason: 'prompt digest did not match handoff evidence' };
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
