import type {
  CopilotDangerousLaunchBinding,
  CopilotStartParams,
} from '@farmslot/protocol';

export function copilotRuntimeStatusLabel(status: string): string {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

export function dangerousLaunchSummary(binding: CopilotDangerousLaunchBinding): string {
  return `${binding.checkout} · ${binding.branch} · ${binding.dirtyFileCount} dirty · ${binding.runner}/${binding.model}`;
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
    confirmation: {
      fingerprint: binding.fingerprint,
      typedPhrase,
      warningAcknowledged: true,
    },
  };
}
