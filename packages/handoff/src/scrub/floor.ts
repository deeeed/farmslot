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
 * Build a regex that strips zero-width and Unicode formatting characters.
 * Uses explicit numeric code points so the source file contains no invisible
 * or ambiguous characters.
 *
 * Code points covered:
 *   0x00AD  soft hyphen
 *   0x034F  combining grapheme joiner
 *   0x115F  Hangul choseong filler
 *   0x1160  Hangul jungseong filler
 *   0x17B4  Khmer vowel inherent AQ
 *   0x17B5  Khmer vowel inherent AA
 *   0x200B-0x200F  zero-width space, ZWNJ, ZWJ, LRM, RLM
 *   0x2028-0x2029  line separator, paragraph separator
 *   0x202A-0x202E  bidi embedding and override controls
 *   0x2060-0x206F  word joiner and variation selectors
 *   0xFEFF  zero-width no-break space / BOM
 */
function buildZeroWidthPattern(): RegExp {
  const codePoints: number[] = [
    0x00ad, // soft hyphen
    0x034f, // combining grapheme joiner
    0x115f,
    0x1160, // Hangul fillers
    0x17b4,
    0x17b5, // Khmer inherent vowels
    0x200b,
    0x200c,
    0x200d,
    0x200e,
    0x200f, // ZW space, ZWNJ, ZWJ, LRM, RLM
    0x2028,
    0x2029, // line / paragraph separator
    0x202a,
    0x202b,
    0x202c,
    0x202d,
    0x202e, // bidi controls
    ...Array.from({ length: 16 }, (_, i) => 0x2060 + i), // word joiner + variation selectors
    0xfeff, // BOM
  ];
  const chars = codePoints.map((cp) => String.fromCodePoint(cp)).join('');
  return new RegExp(`[${chars}]`, 'g');
}

const ZERO_WIDTH_PATTERN = buildZeroWidthPattern();

/**
 * Normalize text before secret detection. NFKC resolves compatibility equivalents
 * (full-width Latin, superscript digits, ligatures) so obfuscated labels map to
 * their canonical ASCII forms. Stripping zero-width and formatting characters
 * removes invisible spacer injections between label characters.
 */
function normalizeForScan(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH_PATTERN, '');
}

/**
 * Positive-identification patterns for the crypto-secret floor. Each is
 * distinctive enough that a match is a secret, not a false positive: provider
 * tokens carry unique prefixes, keys carry labels or PEM armor. Bare hashes
 * (sha256 digests, tx hashes) are deliberately NOT matched so real package
 * integrity fields never false-block.
 *
 * Key-label patterns use `{0,4}` spacing quantifiers to catch extra-space
 * obfuscation surviving after NFKC normalization. The value side accepts both
 * 64-char hex (with or without 0x) and base64-opaque payloads >= 40 chars so
 * base64-encoded key material is caught even without PEM armor.
 */
const FLOOR_PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
  {
    kind: 'private-key',
    pattern:
      /(?:private[_\s-]{0,4}key|privkey|secret[_\s-]{0,4}key)["'\s:=>]{1,6}(?:0x[0-9a-fA-F]{64}|[A-Za-z0-9+/]{40,}={0,2})/gi,
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
];

/**
 * Detect BIP-39 recovery phrases: runs of >= 12 consecutive wordlist words.
 * Tokenizing on any non-letter boundary catches obfuscated separators - newlines,
 * multiple spaces, commas, numbered lists - since natural prose breaks such runs
 * with stopwords (which are absent from the wordlist) long before 12 words.
 *
 * Accepts pre-normalized text (NFKC + zero-width stripped); `toLowerCase()` is
 * still applied for BIP-39 wordlist comparison.
 */
function detectMnemonics(normalizedText: string): FloorHit[] {
  const tokens = normalizedText.toLowerCase().split(/[^a-z]+/);
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
 * A base64 run >= 80 characters encodes at least 60 raw bytes — sufficient to
 * carry a 32-byte symmetric key or the opening of a PEM block with body.
 */
const BASE64_RUN = /[A-Za-z0-9+/]{80,}={0,2}/g;

function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
  }
  return printable / buf.length >= 0.85;
}

/**
 * Detect secrets hidden inside base64-encoded payloads. Any standard-alphabet
 * base64 run >= 80 chars is decoded and, if the decoded bytes look like printable
 * text, the floor patterns and mnemonic detector are run on the decoded content
 * (one level — no recursion). This catches base64-wrapped PEM blocks and
 * base64-encoded labeled key assignments that would otherwise bypass literal
 * pattern matching.
 */
function detectBase64Wrapped(text: string): FloorHit[] {
  const hits: FloorHit[] = [];
  for (const runMatch of text.matchAll(BASE64_RUN)) {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(runMatch[0], 'base64');
    } catch {
      continue;
    }
    if (!looksLikeText(decoded)) continue;
    const inner = normalizeForScan(decoded.toString('utf8'));
    for (const { kind, pattern } of FLOOR_PATTERNS) {
      for (const match of inner.matchAll(new RegExp(pattern.source, pattern.flags))) {
        hits.push({ kind, fingerprint: fingerprint(match[0]) });
      }
    }
    for (const hit of detectMnemonics(inner)) {
      hits.push(hit);
    }
  }
  return hits;
}

/**
 * Scan text for the crypto-secret floor. Returns one deduplicated hit per
 * distinct secret. A non-empty result means the file — and therefore the
 * package — MUST be blocked (fail-closed).
 *
 * Detection layers applied in order:
 * 1. NFKC normalization + zero-width stripping — neutralizes homoglyph and
 *    invisible-spacer obfuscation on key labels.
 * 2. Literal pattern matching on normalized text — recovery phrases, labeled
 *    keys, provider tokens, PEM armor.
 * 3. Base64-decode scan — decodes long opaque base64 runs and re-applies the
 *    same patterns on the decoded content to catch wrapped payloads.
 */
export function scanForFloorSecrets(text: string): FloorHit[] {
  const normalized = normalizeForScan(text);
  const byFingerprint = new Map<string, FloorHit>();

  for (const hit of detectMnemonics(normalized)) {
    byFingerprint.set(hit.fingerprint, hit);
  }
  for (const { kind, pattern } of FLOOR_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      const hit: FloorHit = { kind, fingerprint: fingerprint(match[0]) };
      byFingerprint.set(hit.fingerprint, hit);
    }
  }
  for (const hit of detectBase64Wrapped(text)) {
    byFingerprint.set(hit.fingerprint, hit);
  }

  return [...byFingerprint.values()];
}
