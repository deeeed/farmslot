import {
  type CopilotDangerousLaunchBinding,
  type CopilotStartParams,
  type CopilotStatusResult,
  Methods,
} from '@farmslot/protocol';
import { type ResourceQuery, resourceQuery } from '@farmslot/protocol/client-cache';

/**
 * Only an open panel shows the runtime. Its status depends on every run, slot and worker
 * change, so a closed panel holding it would reread it all the time on a busy farm.
 */
export function copilotStatusQuery(open: boolean): ResourceQuery<CopilotStatusResult> | undefined {
  return open ? resourceQuery<CopilotStatusResult>(Methods.COPILOT_STATUS, {}) : undefined;
}

export function copilotRuntimeStatusLabel(status: string): string {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

export function dangerousLaunchSummary(binding: CopilotDangerousLaunchBinding): string {
  return `${binding.checkout} · ${binding.branch} · ${binding.dirtyFileCount} dirty · ${binding.runner}/${binding.model}${binding.effort ? ` · ${binding.effort} effort` : ''}`;
}

export function dangerousStartParams(
  binding: CopilotDangerousLaunchBinding,
  typedPhrase: string,
): CopilotStartParams | null {
  if (typedPhrase !== binding.typedPhrase) return null;
  return {
    safetyTier: 'dangerous',
    runner: binding.runner,
    model: binding.model,
    ...(binding.effort !== undefined ? { effort: binding.effort } : {}),
    confirmation: {
      fingerprint: binding.fingerprint,
      typedPhrase,
      warningAcknowledged: true,
    },
  };
}
