import type { ProviderAccountsSnapshot } from '../contracts/provider-accounts.js';

export interface ProviderAccountsSnapshotParams {
  /** Limit to these machine ids. Omit = all machines present in fleet. */
  machines?: string[];
  /**
   * Wait for a fresh probe instead of accepting a cached snapshot. Probes can
   * take ~20s per machine (identity + CodexBar CLIs), so the gateway serves the
   * last snapshot and refreshes in the background by default; an explicit
   * operator Refresh sets this to get live truth.
   */
  forceRefresh?: boolean;
}

export type ProviderAccountsSnapshotResult = ProviderAccountsSnapshot;
