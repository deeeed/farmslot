import { type MachineParkingService, machineParkingService } from './service.js';

/**
 * Reconcile write-ahead park records before normal run-engine recovery. This is deliberately
 * observation-only: an interrupted multi-run release is surfaced as partial rather than replaying
 * destructive effects after a restart without a fresh operator request.
 */
export async function reconcileMachineParking(
  service: Pick<MachineParkingService, 'reconcile'> = machineParkingService,
): Promise<{ reconciled: number; partial: number }> {
  const result = await service.reconcile();
  if (result.reconciled > 0) {
    console.log(
      `[machine-pause] reconciled ${result.reconciled} persisted record(s), ${result.partial} partial`,
    );
  }
  return result;
}
