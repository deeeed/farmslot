import { RUN_SLUG_PATTERN } from '../spec/version.js';

/** True iff `slug` satisfies the spec section 1 run-slug grammar. */
export function isValidRunSlug(slug: string): boolean {
  return RUN_SLUG_PATTERN.test(slug);
}
