interface ConversationStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface ConversationControlTransition {
  pending: Promise<unknown>;
  writeFailure?: unknown;
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
  const controls = new Map<string, ConversationControlTransition>();
  return {
    async read(key: string) {
      for (;;) {
        const control = controls.get(key);
        if (control) {
          // Submitters receive command errors. Remounts read only after the
          // journal has retained an uncertain intent or rolled back an unsent one.
          await Promise.allSettled([control.pending]);
          if ('writeFailure' in control) throw control.writeFailure;
          continue;
        }
        const write = writes.get(key);
        if (write) {
          await write;
          continue;
        }
        return storage.getItem(key);
      }
    },
    transition<T>(key: string, action: () => Promise<T>): Promise<T> {
      if (controls.has(key))
        return Promise.reject(new Error('Conversation controls are still settling. Try again.'));
      const control: ConversationControlTransition = { pending: Promise.resolve() };
      const pending = Promise.resolve()
        .then(action)
        .finally(() => {
          if (controls.get(key) === control) controls.delete(key);
        });
      control.pending = pending;
      controls.set(key, control);
      return pending;
    },
    write(key: string, value: string) {
      const write = async () => {
        try {
          await storage.setItem(key, value);
          const control = controls.get(key);
          if (control) delete control.writeFailure;
        } catch (error) {
          const control = controls.get(key);
          if (control) control.writeFailure = error;
          throw error;
        }
      };
      // Each caller receives its failure; a later edit can retry a failed write.
      const pending = (writes.get(key) ?? Promise.resolve()).then(write, write).finally(() => {
        if (writes.get(key) === pending) writes.delete(key);
      });
      writes.set(key, pending);
      return pending;
    },
  };
}
