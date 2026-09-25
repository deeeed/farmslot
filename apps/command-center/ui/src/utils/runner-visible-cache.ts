const visibleByRunner = new Map<string, string[]>();

/** Remember the gateway's visible models so other pickers in this page use the same list. */
export function rememberVisibleModels(runner: string, models: readonly string[]): void {
  visibleByRunner.set(runner, [...models]);
}

export function rememberedVisibleModels(runner: string): string[] | null {
  const models = visibleByRunner.get(runner);
  return models ? [...models] : null;
}
