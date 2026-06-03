import type { EvalCaseCatalogItem } from './eval-suite-helpers.js';

export function evalCatalogProjectOptions(items: readonly EvalCaseCatalogItem[]): string[] {
  return [...new Set(items.map((item) => item.project).filter(Boolean))].sort();
}

export function evalCatalogStatusOptions(items: readonly EvalCaseCatalogItem[]): string[] {
  return [...new Set(items.map((item) => item.statusLabel).filter(Boolean))].sort();
}
