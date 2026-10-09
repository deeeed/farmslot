export const RESOURCE_CONTROL_TIMEOUT_MS = 150_000;
export const RUNTIME_CAPABILITY_ACQUIRE_TIMEOUT_MS = 420_000;
/**
 * Slot prepare, release, recycle and slot actions can take minutes on remote
 * machines; run.archive shares it because it may release a blocked run's slot.
 */
export const SLOT_OPERATION_TIMEOUT_MS = 5 * 60_000;
