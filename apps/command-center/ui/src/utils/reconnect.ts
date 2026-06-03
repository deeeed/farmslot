import { gateway } from '../gateway-client.js';
import { waitForCoreHydration } from '../state.js';

export type RecoveryPhase = 'live' | 'stale' | 'rehydrating' | 'error';

export function currentRecoveryEpoch(): number {
  return gateway.connectionEpoch;
}

export function isRecoveryEpochCurrent(epoch: number): boolean {
  return gateway.connectionState === 'connected' && gateway.connectionEpoch === epoch;
}

export async function waitForRecoveryHydration(epoch: number): Promise<boolean> {
  await waitForCoreHydration(epoch);
  return isRecoveryEpochCurrent(epoch);
}
