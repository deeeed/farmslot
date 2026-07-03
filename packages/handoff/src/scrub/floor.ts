import { createHash } from 'node:crypto';

import { BIP39_ENGLISH } from './data/bip39-english.js';

/** A positive-identification hit from the crypto-secret floor. */
export interface FloorHit {
  kind: string;
  /** sha256:<12> of the matched text - never the raw secret value. */
  fingerprint: string;
}

const BIP39_SET = new Set<string>(BIP39_ENGLISH);

/**
 * Standard BIP-39 mnemonic lengths. A run of consecutive wordlist words at one of
 * these lengths is a positive seed-recovery-phrase identification.
 */
const MNEMONIC_MIN_LENGTH = 12;

function fingerprint(match: string): string {
  return `sha256:${createHash('sha256').update(match).digest('hex').slice(0, 12)}`;
}

/**
 * Positive-identification patterns for the crypto-secret floor. Each is
 * distinctive enough that a match is a secret, not a false positive: provider
 * tokens carry unique prefixes, keys carry labels or PEM armor. Bare hashes
 * (sha256 digests, tx hashes) are deliberately NOT matched so real package
 * integrity fields never false-block.
 */
const FLOOR_PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
  {
    kind: 'private-key',
    pattern:
      /(?:private[_\s-]?key|privkey|secret[_\s-]?key)["'\s:=>]{1,6}(?:0x)?[0-9a-fA-F]{64}\b/gi,
  },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'basic-auth', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi },
];

/**
 * Detect BIP-39 recovery phrases: runs of >= 12 consecutive wordlist words.
 * Tokenizing on any non-letter boundary catches obfuscated separators - newlines,
 * multiple spaces, commas, numbered lists - since natural prose breaks such runs
 * with stopwords (which are absent from the wordlist) long before 12 words.
 */
function detectMnemonics(text: string): FloorHit[] {
  const tokens = text.toLowerCase().split(/[^a-z]+/);
  const hits: FloorHit[] = [];
  let runStart = -1;
  for (let i = 0; i <= tokens.length; i += 1) {
    const isWord = i < tokens.length && tokens[i] !== '' && BIP39_SET.has(tokens[i]);
    if (isWord) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1 && i - runStart >= MNEMONIC_MIN_LENGTH) {
        hits.push({ kind: 'srp', fingerprint: fingerprint(tokens.slice(runStart, i).join(' ')) });
      }
      runStart = -1;
    }
  }
  return hits;
}

/**
 * Scan text for the crypto-secret floor. Returns one deduplicated hit per
 * distinct secret. A non-empty result means the file - and therefore the package -
 * MUST be blocked (fail-closed).
 */
export function scanForFloorSecrets(text: string): FloorHit[] {
  const byFingerprint = new Map<string, FloorHit>();
  for (const hit of detectMnemonics(text)) {
    byFingerprint.set(hit.fingerprint, hit);
  }
  for (const { kind, pattern } of FLOOR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const hit: FloorHit = { kind, fingerprint: fingerprint(match[0]) };
      byFingerprint.set(hit.fingerprint, hit);
    }
  }
  return [...byFingerprint.values()];
}
