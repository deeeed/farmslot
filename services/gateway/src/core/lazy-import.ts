/**
 * Loads a module on first use and keeps it, for call sites an import cycle or a test module
 * mock keeps from importing statically. Under tsx each `import()` call runs the resolve hooks
 * again, so a hot path must not call it per request. A failed load is not kept: the next
 * call tries again, as a per-call `import()` would.
 */
export function lazyImport<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () =>
    (loading ??= load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    }));
}
