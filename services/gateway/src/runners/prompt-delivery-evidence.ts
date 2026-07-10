import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { resolveTmuxPaneId, shellQuote } from '../core/tmux.js';

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

export async function readLaunchAckSignalSince(
  vars: SlotVars,
  signalPath: string,
  sinceMs: number,
): Promise<boolean> {
  const result = await execOnSlot(
    vars,
    `cat ${shellQuote(signalPath)} 2>/dev/null`,
    vars.remoteRepo,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return false;
  const raw = result.stdout.trim();
  if (!raw.includes('"status"')) return false;
  if (!/"status"\s*:\s*"(?:running|working)"/.test(raw)) return false;
  const stat = await execOnSlot(
    vars,
    `stat -f %m ${shellQuote(signalPath)} 2>/dev/null || stat -c %Y ${shellQuote(signalPath)} 2>/dev/null || echo 0`,
    vars.remoteRepo,
  );
  const mtimeSec = Number.parseInt(stat.stdout.trim(), 10);
  const mtimeMs = Number.isFinite(mtimeSec) ? mtimeSec * 1000 : 0;
  return mtimeMs >= sinceMs - 1000;
}

export async function probeRunnerHandoffAck(
  vars: SlotVars,
  target: string,
  message: string,
  sinceMs: number,
  opts: {
    paneId?: string | null;
    launchAckSignalPath?: string | null;
    preferHooks?: boolean;
    requirePromptDigest?: boolean;
  } = {},
): Promise<RunnerHandoffAckProbe> {
  if (opts.launchAckSignalPath && !opts.requirePromptDigest) {
    const launchAck = await readLaunchAckSignalSince(vars, opts.launchAckSignalPath, sinceMs);
    if (launchAck) {
      return {
        accepted: true,
        reason: `launch ack signal updated at ${opts.launchAckSignalPath}`,
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
