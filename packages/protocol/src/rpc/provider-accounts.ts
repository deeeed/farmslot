import type { ProviderAccountsSnapshot } from '../contracts/provider-accounts.js';

export interface ProviderAccountsSnapshotParams {
  /** Limit to these machine ids. Omit = all machines present in fleet. */
  machines?: string[];
}

export type ProviderAccountsSnapshotResult = ProviderAccountsSnapshot;
