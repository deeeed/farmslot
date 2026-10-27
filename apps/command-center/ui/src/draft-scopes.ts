import type { DraftStore } from '@farmslot/local-store/drafts';

import { gateway } from './gateway-client.js';

/**
 * Each drafts scope's retirements in this document. While one runs the scope is closed; once it
 * has ended, only a connection opened after that reopens it.
 */
const retirements = new Map<string, { count: number; reopensAfter?: number }>();
/** Draft writes running per scope; a retirement waits for them before it deletes. */
const running = new Map<string, Set<Promise<unknown>>>();

export interface DraftScopeWriter {
  /** No retirement of the scope has come since this writer was taken. */
  live(): boolean;
  /** Runs one store write while the writer is live; undefined once it is not. */
  write<T>(run: () => Promise<T>): Promise<T | undefined>;
}

/**
 * Binds draft work to its scope as it is now. Retiring the scope (sign-out, another principal)
 * ends every writer taken before, and refuses new ones until a connection opened after it ended,
 * so no work brings a deleted draft back.
 */
export function draftScopeWriter(scopeId: string): DraftScopeWriter {
  const taken = retirements.get(scopeId);
  const open =
    !taken ||
    (taken.reopensAfter !== undefined && gateway.resourceConnectionId > taken.reopensAfter);
  const live = () => open && retirements.get(scopeId)?.count === taken?.count;
  return {
    live,
    async write(run) {
      if (!live()) return undefined;
      const writing = run();
      const writes = running.get(scopeId) ?? new Set<Promise<unknown>>();
      running.set(scopeId, writes.add(writing));
      try {
        return await writing;
      } finally {
        writes.delete(writing);
      }
    },
  };
}

/**
 * Drafts rule 6: deletes a scope's drafts for good, once the writes already running land. The
 * scope stays closed until `then` (signing out) has finished too, whatever reconnects meanwhile.
 */
export async function retireDraftScope(
  store: DraftStore,
  scopeId: string,
  then?: () => Promise<void>,
): Promise<void> {
  const count = (retirements.get(scopeId)?.count ?? 0) + 1;
  retirements.set(scopeId, { count });
  try {
    await Promise.allSettled(running.get(scopeId) ?? []);
    await store.deleteScope(scopeId);
    await then?.();
  } finally {
    // A later retirement that started meanwhile keeps the scope closed until it ends itself.
    if (retirements.get(scopeId)?.count === count)
      retirements.set(scopeId, { count, reopensAfter: gateway.resourceConnectionId });
  }
}
