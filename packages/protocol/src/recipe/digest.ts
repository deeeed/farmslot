import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { isRecord } from './common.js';

const RECIPE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

export function canonicalRecipeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecipeJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRecipeJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function digestRecipeDocument(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalRecipeJson(value))))}`;
}

/** Return the only valid artifact path for an exact resolved Recipe v1 digest. */
export function resolvedRecipeArtifactPath(digest: unknown): string | undefined {
  if (typeof digest !== 'string' || !RECIPE_DIGEST_RE.test(digest)) return undefined;
  return `resolved-recipes/${digest.slice('sha256:'.length)}.recipe.json`;
}
