interface ConversationStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function nativeConversationStorageKey(identity: {
  profile: string;
  gatewayUrl: string;
  principalId: string | null;
  node: string;
  sessionId?: string;
  runId?: string;
  contextId?: string;
  leaseId?: string;
}) {
  return `@farmslot:native:${JSON.stringify([
    identity.profile,
    identity.gatewayUrl,
    identity.principalId,
    identity.node,
    identity.sessionId,
    identity.runId,
    identity.contextId,
    identity.leaseId,
  ])}`;
}

/** Share one instance across controllers so reconnects cannot race pending writes. */
export function createNativeConversationStorage(storage: ConversationStorage) {
  const writes = new Map<string, Promise<void>>();
  return {
    async read(key: string) {
      await writes.get(key);
      return storage.getItem(key);
    },
    write(key: string, value: string) {
      const write = () => storage.setItem(key, value);
      // Each caller receives its failure; a later edit can retry a failed write.
      const pending = (writes.get(key) ?? Promise.resolve()).then(write, write).finally(() => {
        if (writes.get(key) === pending) writes.delete(key);
      });
      writes.set(key, pending);
      return pending;
    },
  };
}
