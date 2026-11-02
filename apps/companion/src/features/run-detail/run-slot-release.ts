import { cancelledRunSlotChoices } from '@farmslot/protocol';

/**
 * The cancelled run's slot release Run Detail offers. Releasing is a write, so only run.get's
 * own run, while actions may run on it (`runActionable`), decides it; a list row never does.
 */
export function offeredSlotRelease(
  run: Parameters<typeof cancelledRunSlotChoices>[0],
  slots: Parameters<typeof cancelledRunSlotChoices>[1],
  runActionable: boolean,
) {
  return runActionable ? cancelledRunSlotChoices(run, slots) : null;
}
