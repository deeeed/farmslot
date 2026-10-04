// "Did you mean" suggestions for a mistyped command, option, value or action.

/** The candidate nearest `input` by edit distance, or undefined when none is close. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: levenshtein(input, candidate) }))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.candidate.localeCompare(right.candidate),
    );
  const best = ranked[0];
  if (!best) return undefined;
  const threshold = Math.max(2, Math.floor(Math.max(input.length, best.candidate.length) / 3));
  return best.distance <= threshold ? best.candidate : undefined;
}

// Optimal string alignment distance: an adjacent transposition costs one edit.
function levenshtein(left: string, right: string): number {
  let twoBack: number[] | undefined;
  let prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        prior[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (prior[rightIndex] ?? 0) + 1,
        substitution,
      );
      if (
        twoBack &&
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        current[rightIndex] = Math.min(
          current[rightIndex] ?? 0,
          (twoBack[rightIndex - 2] ?? 0) + 1,
        );
      }
    }
    twoBack = prior;
    prior = current;
  }
  return prior[right.length] ?? right.length;
}
