import { createHash } from 'node:crypto';

import { BIP39_ENGLISH } from './data/bip39-english.js';

/** A positive-identification hit from the crypto-secret floor. */
export interface FloorHit {
  kind: string;
  /** sha256:<12> of the matched text - never the raw secret value. */
  fingerprint: string;
}

/** One deny pattern: a match is a positive secret identification, never a maybe. */
export interface FloorPattern {
  kind: string;
  pattern: RegExp;
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
 *
 * The scrubber is a light heuristic backstop against ACCIDENTAL inclusion by a
 * cooperative producing agent. It is not an adversarial-content filter. The
 * primary control is the producer-instruction in the closeout prompt; the human
 * approval gate is the reliability guarantee.
 */
const FLOOR_PATTERNS: FloorPattern[] = [
  { kind: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
  {
    kind: 'private-key',
    pattern:
      /(?:private[_\s-]?key|privkey|secret[_\s-]?key)["'\s:=>]{1,6}(?:0x)?[0-9a-fA-F]{64}\b/gi,
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'basic-auth', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi },
  { kind: 'oauth-token', pattern: /\bya29\.[A-Za-z0-9_-]{20,}\b/g },
  // HTTP cookie header carrying a session value (Cookie:/Set-Cookie: name=value...).
  { kind: 'cookie', pattern: /\b(?:set-cookie|cookie):\s*[A-Za-z0-9_.-]+=[^\s;,]{8,}/gi },
  // Session/auth-token assignments with a value-shaped token on the right.
  {
    kind: 'session-token',
    pattern: /\b(?:session[_-]?(?:id|token)|auth[_-]?token)["'\s:=>]{1,6}[A-Za-z0-9+/_.-]{16,}\b/gi,
  },
];

/**
 * Detect BIP-39 recovery phrases: runs of >= 12 consecutive wordlist words.
 * Tokenizing on any non-letter boundary catches common accidental separators —
 * newlines, commas, numbered list prefixes — since natural prose breaks such
 * runs with stopwords long before 12 words. Literal escape sequences (\n, \t,
 * \r) become separators first so a phrase inside a JSON-stringified blob (a
 * very common accidental carrier: embedded logs in summary.json) still tokenizes
 * as a word run instead of gluing the escape letter onto the next word.
 */
function detectMnemonics(text: string): FloorHit[] {
  const tokens = text
    .toLowerCase()
    .replace(/\\[ntr]/g, ' ')
    .split(/[^a-z]+/);
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
 * distinct secret. A non-empty result means the file — and therefore the
 * package — MUST be blocked (fail-closed).
 *
 * SCRUBBER GUARANTEE MODEL: this is a best-effort backstop against accidental
 * secret inclusion by a cooperative producing agent. The primary control is the
 * producer-instruction contract ("never include raw secrets; reference by name
 * only"). The human approval gate is the reliability guarantee. The scrubber
 * does not attempt to defeat adversarial obfuscation.
 *
 * `extraPatterns` (farm/personal config) is UNION-only (spec section 5.1 layer 5):
 * it can only ADD deny patterns on top of the floor. There is no parameter, flag,
 * or config path that removes or replaces a floor pattern.
 */
export function scanForFloorSecrets(text: string, extraPatterns: FloorPattern[] = []): FloorHit[] {
  const byFingerprint = new Map<string, FloorHit>();

  for (const hit of detectMnemonics(text)) {
    byFingerprint.set(hit.fingerprint, hit);
  }
  for (const { kind, pattern } of [...FLOOR_PATTERNS, ...extraPatterns]) {
    for (const match of text.matchAll(pattern)) {
      const hit: FloorHit = { kind, fingerprint: fingerprint(match[0]) };
      byFingerprint.set(hit.fingerprint, hit);
    }
  }

  return [...byFingerprint.values()];
}
