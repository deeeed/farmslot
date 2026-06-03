import { basename } from './slot-view-model.js';

export function fuzzyFilterSlotViewFiles(fileIndex: readonly string[], rawQuery: string): string[] {
  const query = rawQuery.toLowerCase();
  if (!query) return [];

  // Simple fuzzy match: all chars of query appear in order in the filename.
  const results: Array<{ path: string; score: number }> = [];
  for (const filePath of fileIndex) {
    const lower = filePath.toLowerCase();
    const name = basename(filePath).toLowerCase();
    // Try basename first for scoring.
    let score: number;
    // Exact substring in basename gets highest score.
    if (name.includes(query)) {
      score = 100 - name.indexOf(query);
    } else if (lower.includes(query)) {
      score = 50;
    } else {
      let qi = 0;
      for (let i = 0; i < lower.length && qi < query.length; i++) {
        if (lower[i] === query[qi]) qi++;
      }
      if (qi < query.length) continue;
      score = 10;
    }
    results.push({ path: filePath, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.map((result) => result.path);
}
