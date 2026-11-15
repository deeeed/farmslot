import type { EvalBlindTrial } from '@farmslot/protocol';

/** Legacy and proof trials keep their capsule policy across retries. */
export function usesEvalTrialCapsule(trial: EvalBlindTrial | undefined): boolean {
  return !!trial && trial.executionPolicy !== 'normal-slot';
}
