import { createHash } from 'node:crypto';

import type {
  CopilotCheckoutIdentity,
  CopilotDangerousConfirmation,
  CopilotDangerousLaunchBinding,
} from '@farmslot/protocol';

export const COPILOT_DANGEROUS_TYPED_PHRASE = 'ENABLE DANGEROUS CO-PILOT';
export const COPILOT_DANGEROUS_WARNING =
  'Dangerous same-user OS access is not hard containment. Execution permission does not authorize gate approval, publication, merge, release, deletion, cancellation, backlog dispatch, or dispatch expansion.';

export function dangerousLaunchBinding(input: {
  checkout: CopilotCheckoutIdentity;
  runner: string;
  model: string;
}): CopilotDangerousLaunchBinding {
  const bound = {
    checkout: input.checkout.path,
    branch: input.checkout.branch,
    head: input.checkout.head,
    dirtyFileCount: input.checkout.dirtyFileCount,
    runner: input.runner,
    model: input.model,
    safetyTier: 'dangerous' as const,
    typedPhrase: COPILOT_DANGEROUS_TYPED_PHRASE,
    warning: COPILOT_DANGEROUS_WARNING,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(bound)).digest('hex');
  return {
    ...bound,
    fingerprint,
  };
}

export function assertDangerousConfirmation(
  binding: CopilotDangerousLaunchBinding,
  confirmation: CopilotDangerousConfirmation | undefined,
): void {
  if (!confirmation) throw new Error('Dangerous Co-Pilot start requires typed confirmation');
  if (confirmation.fingerprint !== binding.fingerprint) {
    throw new Error('Dangerous Co-Pilot confirmation no longer matches the displayed launch metadata');
  }
  if (confirmation.typedPhrase !== binding.typedPhrase) {
    throw new Error(`Dangerous Co-Pilot confirmation must exactly match: ${binding.typedPhrase}`);
  }
  if (confirmation.warningAcknowledged !== true) {
    throw new Error('Dangerous Co-Pilot start requires the same-user containment warning');
  }
}
