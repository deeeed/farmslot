import { levenshtein, type RecipeDiscoveryIndex } from './discovery-index.js';
import type { SearchResult } from './types.js';

interface Searchable {
  kind: SearchResult['kind'];
  name: string;
  source: string | null;
  description: string;
  fields: string[];
}

/** Rank actions and recipes by id, parameter names and description; every term must match. */
export function searchIndex(index: RecipeDiscoveryIndex, query: string): SearchResult[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const entries: Searchable[] = [
    ...[...index.actions.values()].map((action) => ({
      kind: 'action' as const,
      name: action.name,
      source: action.source,
      description: action.description,
      fields: action.parameters.map((parameter) => parameter.name),
    })),
    ...[...index.recipes.values()].map((recipe) => ({
      kind: 'recipe' as const,
      name: recipe.ref,
      source: recipe.source,
      description: [recipe.title, recipe.description].filter(Boolean).join(' '),
      fields: recipe.parameters.map((parameter) => parameter.name),
    })),
  ];
  return entries
    .map((entry) => {
      const scores = terms.map((term) => termScore(entry, term));
      return { entry, scores, score: scores.reduce((total, value) => total + value, 0) };
    })
    .filter(({ scores }) => scores.every((value) => value > 0))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.kind.localeCompare(right.entry.kind) ||
        left.entry.name.localeCompare(right.entry.name),
    )
    .map(({ entry, score }) => ({
      kind: entry.kind,
      name: entry.name,
      score,
      source: entry.source,
      description: entry.description,
    }));
}

function termScore(entry: Searchable, term: string): number {
  const name = entry.name.toLowerCase();
  const segment = name.split('.').pop() ?? name;
  const domain = name.includes('.') ? name.split('.')[0]! : '';
  const nameTerms = searchTerms(name.replaceAll('.', ' ').replaceAll('_', ' '));
  const fields = entry.fields.map((field) => field.toLowerCase());
  if (name === term) return 120;
  if (segment === term) return 110;
  if (domain === term) return 100;
  if (fields.includes(term)) return 90;
  if (nameTerms.includes(term)) return 80;
  if (name.includes(term)) return 70;
  if (fields.some((field) => field.includes(term))) return 60;
  if (entry.description.toLowerCase().includes(term)) return 50;
  if ([...nameTerms, ...fields].some((candidate) => fuzzyMatch(term, candidate))) return 40;
  return 0;
}

function fuzzyMatch(term: string, candidate: string): boolean {
  if (term.length < 4 || candidate.length < 4) return false;
  const threshold = Math.max(1, Math.floor(Math.max(term.length, candidate.length) / 4));
  return levenshtein(term, candidate) <= threshold;
}

function searchTerms(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
}
