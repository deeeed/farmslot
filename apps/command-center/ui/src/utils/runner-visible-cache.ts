const visibleByRunner = new Map<string, string[]>();
const defaultByRunner = new Map<string, string>();
const listeners = new Set<() => void>();

export function onVisibleModelsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearVisibleModels(): void {
  visibleByRunner.clear();
  defaultByRunner.clear();
  for (const listener of listeners) listener();
}

/** Remember the gateway's visible models so other pickers in this page use the same list. */
export function rememberVisibleModels(
  runner: string,
  models: readonly string[],
  defaultModel?: string,
): void {
  const unchanged =
    JSON.stringify(visibleByRunner.get(runner)) === JSON.stringify(models) &&
    (defaultModel === undefined || defaultByRunner.get(runner) === defaultModel);
  if (unchanged) return;
  visibleByRunner.set(runner, [...models]);
  if (defaultModel !== undefined) defaultByRunner.set(runner, defaultModel);
  for (const listener of listeners) listener();
}

export function rememberedDefaultModel(runner: string): string | undefined {
  return defaultByRunner.get(runner);
}

export function rememberedVisibleModels(runner: string): string[] | null {
  const models = visibleByRunner.get(runner);
  return models ? [...models] : null;
}
