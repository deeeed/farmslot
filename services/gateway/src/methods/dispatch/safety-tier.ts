// methods/dispatch/safety-tier.ts — Dispatch-time safety-tier precedence.

import type { SafetyTier } from '@farmslot/protocol';

import { isValidSafetyTier } from '../../fleet/state.js';

/**
 * Dispatch-time safety tier resolution (ADR-023).
 *
 * Order: explicit params > persisted run > project default > undefined.
 * Returning undefined lets `buildLaunchCommand` fall through to the runner
 * registry's intrinsic default (sandboxed) via `runnerFlagsForTier`.
 *
 * Internal `dispatchExecute` calls from the run-engine arrive without a Run
 * when replaying or when legacy CLI flows bypass `run.create`. Those call
 * sites rely on the project-level default to recover the pre-refactor
 * autonomous posture after pool templates switched to `{safety_flags}`.
 */
export function resolveDispatchSafetyTier(inputs: {
  paramsTier?: SafetyTier;
  runTier?: SafetyTier | undefined;
  projectDefaultRaw?: unknown;
}): SafetyTier | undefined {
  if (inputs.paramsTier !== undefined) return inputs.paramsTier;
  if (inputs.runTier !== undefined) return inputs.runTier;
  if (isValidSafetyTier(inputs.projectDefaultRaw)) return inputs.projectDefaultRaw;
  return undefined;
}
