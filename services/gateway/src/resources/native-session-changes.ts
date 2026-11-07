interface NativeSessionListener {
  nodeId: string;
  ownerId: string;
  changed(): void;
}

const listeners = new Set<NativeSessionListener>();

/** Internal wakeups only. Consumers re-read and validate their exact session and lease. */
export function onNativeSessionChange(
  nodeId: string,
  ownerId: string,
  changed: () => void,
): () => void {
  const listener = { nodeId, ownerId, changed };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called only after the native source owner admits its change notification. */
export function publishNativeSessionChange(nodeId: string, ownerId: string): void {
  for (const listener of [...listeners])
    if (listener.nodeId === nodeId && listener.ownerId === ownerId) listener.changed();
}
