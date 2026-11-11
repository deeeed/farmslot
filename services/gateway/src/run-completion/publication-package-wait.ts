import { withRunBundleLockWaitBudget } from '@farmslot/run-bundle';

/** A busy store makes publication unavailable; the gate offers its existing Retry Gate action. */
export function withPublicationPackageStorageWait<T>(prepare: () => Promise<T>): Promise<T> {
  return withRunBundleLockWaitBudget(60_000, prepare);
}
