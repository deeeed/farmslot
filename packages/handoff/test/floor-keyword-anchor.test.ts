import assert from 'node:assert/strict';
import test from 'node:test';

import { GITLEAKS_RULES } from '../src/scrub/data/gitleaks-rules.js';
import { FLOOR_PATTERNS, patternMatches } from '../src/scrub/floor.js';

function globalMatches(pattern: RegExp, text: string): string[] {
  return Array.from(text.matchAll(pattern), (match) => match[0]);
}

// Deterministic token values in the alphabets and lengths vendor rules expect.
function token(alphabet: string, length: number, seed: number): string {
  let value = '';
  for (let i = 0; i < length; i += 1) value += alphabet[(seed * 31 + i * 17) % alphabet.length];
  return value;
}

const HEX = '0123456789abcdef';
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Per rule, assignments keyed by its vendor word with values at the lengths its
 * source names, behind identifier runs at and around the 50- and 100-character
 * prefix bounds, quoted, unquoted and JSON-escaped; plus adjacent and
 * overlapping keywords and a match at the end of the text.
 */
function corpus(): string {
  const lines: string[] = [];
  let seed = 0;
  for (const { kind, pattern } of GITLEAKS_RULES) {
    const vendor = kind.replace('gitleaks:', '').split('-')[0];
    const alphabet = pattern.source.includes('a-f0-9') ? HEX : LOWER;
    const lengths = [...pattern.source.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
    for (const length of lengths.filter((n) => n >= 8).slice(-2)) {
      seed += 1;
      const lead = token('ab_c.d-e1', [0, 49, 50, 51, 100, 101][seed % 6], seed);
      const value = token(alphabet, length, seed);
      lines.push(
        [
          `${lead}${vendor}_api_key = "${value}"`,
          `${lead}${vendor.toUpperCase()}_TOKEN: ${value}`,
          `{\\"${vendor}Token\\":\\"${value}\\"}`,
          `${vendor}${vendor} => '${value}'`,
        ][seed % 4],
      );
    }
  }
  lines.push(`oktaokta = 00${token(LOWER, 40, 7)} okokta okta=00${token(LOWER, 40, 9)}`);
  lines.push(
    `private_key = ${token(HEX, 64, 11)} "secretKey":"${token(HEX, 64, 12)}"`,
    `access_token=${token(LOWER, 32, 13)} session-token: ${token(LOWER, 24, 14)}`,
    `Authorization: Bearer ${token(LOWER, 40, 15)}`,
  );
  return `${lines.join('\n')}\nsentry_token=${token(HEX, 64, 5)}`;
}

test('the anchored search yields exactly the global search matches for every floor and gitleaks rule', () => {
  const texts = [corpus(), ''];
  let rulesWithMatches = 0;
  for (const { kind, pattern } of [...FLOOR_PATTERNS, ...GITLEAKS_RULES]) {
    let matched = false;
    for (const text of texts) {
      const expected = globalMatches(pattern, text);
      assert.deepEqual(patternMatches(pattern, text), expected, kind);
      matched ||= expected.length > 0;
    }
    if (matched) rulesWithMatches += 1;
  }
  // The corpus must exercise real matches, not only agree on empty results.
  assert.ok(rulesWithMatches >= 45, `only ${rulesWithMatches} rules matched the corpus`);
});

test('the anchored search keeps global search semantics for edge-case pattern shapes', () => {
  const text =
    'xx okta=1 oktaokta=22 abcokta=333 ' +
    'w'.repeat(120) +
    'okta=4444 aaaa bbbb key9 KEY8 a-b-c-key7 abababc end okta=5';
  const patterns = [
    /[\w.-]{0,50}?(?:okta)=\d+/g,
    /[\w.-]{0,3}?(?:[\w.-]{0,2}?(?:okta))=\d+/gi,
    /[\w-]{0,4}(?:okta|key)\d?/gi,
    /\b(?:okta)(?:=\d+)?|[a-c-]{0,6}(?:key)\d/gi,
    /(?:okta)=\d+$/g,
    /(\w)(?:okta)=\1*/g,
    /(?<=x )(?:okta)/g,
    /[\w.-]{0,50}?(?:okta)?=\d/g,
    /^.{0,5}(?:okta)/g,
    /(?:abc|)okta/g,
    // The match starts at a keyword match inside another keyword match.
    /(?:abab|ab)c/g,
  ];
  for (const pattern of patterns) {
    assert.deepEqual(patternMatches(pattern, text), globalMatches(pattern, text), String(pattern));
  }
});
