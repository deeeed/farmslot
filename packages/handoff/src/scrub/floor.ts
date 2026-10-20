import { createHash } from 'node:crypto';

import { BIP39_ENGLISH } from './data/bip39-english.js';
import { GITLEAKS_RULES } from './data/gitleaks-rules.js';

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
const BIP39_INDEX = new Map<string, number>(BIP39_ENGLISH.map((word, index) => [word, index]));

/**
 * Standard BIP-39 mnemonic lengths. A window of consecutive wordlist words at one
 * of these lengths whose checksum is valid is a positive seed-recovery-phrase
 * identification.
 */
const MNEMONIC_LENGTHS = [12, 15, 18, 21, 24] as const;
const MNEMONIC_MIN_LENGTH = MNEMONIC_LENGTHS[0];

/**
 * A JSON string literal on one line, escapes included. A bare escape outside a
 * literal is its own alternative, so a match never restarts at an escaped quote
 * (that restart made an unclosed quote before many `\\"` quadratic).
 */
const JSON_STRING_LITERAL = /\\.|"(?:[^"\\\n]|\\.)*"/g;

/** Word offsets a phrase may sit at inside a run: contiguous, or interleaved
 * with one or two wordlist label words (`word 1: x`, `{index, word}` rows). */
const MNEMONIC_STRIDES = [1, 2, 3] as const;

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
  // Labeled-value separator: an actual assignment operator (: = >) with
  // UNBOUNDED quote/backslash/whitespace decoration on both sides - covers
  // JSON-stringified blobs (\":\") and column-aligned config/env dumps
  // (`private_key         = ...`) alike, while the required operator keeps
  // plain prose ("the private key was rotated") from matching.
  {
    kind: 'private-key',
    pattern:
      /(?:private[_\s-]?key|privkey|secret[_\s-]?key)["'\s\\]*[:=>]+["'\s\\]*(?:0x)?[0-9a-fA-F]{64}\b/gi,
  },
  // Only the HEADER reliably starts with eyJ (it always encodes {"alg"/{"typ");
  // the payload can be any base64url - e30 ({}) is a valid empty-claims payload.
  // Minimum lengths on header tail and signature keep short a.b.c identifiers
  // and prose fragments from matching.
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // Legacy npm registry credentials: the canonical .npmrc line is
  // `//registry.../:_authToken=<token>` - the leading underscore defeats a
  // word boundary, so the label is matched bare (case-insensitive) with the
  // structured separator and a token-shaped value (UUID/base64/hex).
  {
    kind: 'npm-token',
    pattern: /_auth[_-]?token["'\s\\]*[:=>]+["'\s\\]*[A-Za-z0-9+/_.~=-]{8,}/gi,
  },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'basic-auth', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi },
  { kind: 'oauth-token', pattern: /\bya29\.[A-Za-z0-9_-]{20,}\b/g },
  // Authorization headers and OAuth token assignments with a value-shaped token.
  {
    kind: 'oauth-token',
    pattern: /\bauthorization["'\s\\]*[:=>]+["'\s\\]*bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    kind: 'oauth-token',
    pattern: /\b(?:access|refresh)[_-]?token["'\s\\]*[:=>]+["'\s\\]*[A-Za-z0-9._~+/-]{20,}\b/gi,
  },
  // Token labels identify credentials; a session ID alone may be a public run
  // or analytics identifier. Cookie/header contexts are checked separately.
  {
    kind: 'session-token',
    pattern:
      /\b(?:session[_-]?token|auth[_-]?token)["'\s\\]*[:=>]+["'\s\\]*[A-Za-z0-9+/_.-]{16,}\b/gi,
  },
];

/**
 * Detect cookie-header session values pair by pair, so a benign first cookie
 * (theme=light) never shields a later session value on the same header. Cookie
 * ATTRIBUTES (Path, Expires, ...) and short benign values are skipped.
 */
// Matches plain headers (Cookie: ...) and JSON-object forms ("Cookie":"...",
// escaped or not). The payload capture admits COMPLETE quoted segments (so
// quoted cookie values like sid="..." survive intact) but stops at a lone
// unmatched quote, which is how a JSON string boundary ends the pair list.
const COOKIE_HEADER = /(?:set-cookie|cookie)["'\\]*\s*:\s*["'\\]*((?:[^\n\r"]|"[^\n\r"]*")+)/gi;
const COOKIE_ATTRIBUTES = /^(?:path|expires|domain|samesite|max-age|secure|httponly|priority)$/i;

/** Strip quote/backslash decoration a pair member picked up from quoting or
 * JSON escaping, so `sid="<value>"` and `sid=\"<value>\"` both yield <value>. */
function stripQuoting(part: string): string {
  return part
    .trim()
    .replace(/^["'\\]+/, '')
    .replace(/["'\\]+$/, '');
}

/**
 * Structured cookie-jar entries as exported by browser profiles/devtools:
 * `{"name":"sid","value":"<token>"}` objects (single or in arrays). The value
 * must be token-shaped (no spaces) and >= 8 chars so prose-ish name/value data
 * never false-blocks.
 */
const COOKIE_OBJECT =
  /"name"\s*:\s*"[A-Za-z0-9_.-]{1,64}"\s*,\s*"value"\s*:\s*"[A-Za-z0-9+/_.~%=-]{8,}"/g;

function detectCookies(text: string): FloorHit[] {
  const hits: FloorHit[] = [];
  for (const jarEntry of text.matchAll(COOKIE_OBJECT)) {
    hits.push({ kind: 'cookie', fingerprint: fingerprint(jarEntry[0]) });
  }
  for (const header of text.matchAll(COOKIE_HEADER)) {
    for (const pair of header[1].split(/[;,]/)) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = stripQuoting(pair.slice(0, eq));
      const value = stripQuoting(pair.slice(eq + 1));
      if (COOKIE_ATTRIBUTES.test(name)) continue;
      if (value.length < 8) continue;
      hits.push({ kind: 'cookie', fingerprint: fingerprint(`${name}=${value}`) });
    }
  }
  return hits;
}

/**
 * One unescape pass over JSON/string escape sequences. Secrets frequently
 * arrive inside JSON-stringified blobs (embedded logs in summary.json); a pass
 * reduces the escape depth by one so escaped content matches the patterns.
 */
function unescapeOnce(text: string): string {
  return text.replace(/\\(["'\\/])/g, '$1').replace(/\\[ntr]/g, ' ');
}

/**
 * Detect BIP-39 recovery phrases. Within any run of >= 12 consecutive wordlist
 * words, every window of a standard mnemonic length (12/15/18/21/24) whose
 * BIP-39 checksum is valid blocks, taking every word, every second word or
 * every third word (a phrase interleaved with wordlist labels). Searching windows inside a longer run keeps
 * the fail-closed case where a wallet dump carries adjacent wordlist words
 * (labels, prefixes); requiring the checksum stops runs of ordinary words, such
 * as recipe intent prose and node ids, from reading as a phrase. A correctly
 * written mnemonic always passes its checksum.
 * In a text that is one JSON document, the caller fences each string holding
 * several words (fenceJsonStringUnits), so a run never crosses from one field's
 * prose into the next key or value; single-word strings (a mnemonic stored as a
 * word array) still compose. A phrase split across separate multi-word JSON
 * values is therefore not composed, as cross-field detection was already
 * scope-capped. Outside a JSON document quotes are ordinary separators, so
 * quoted rows in Markdown, YAML, CSV or plain text still compose, and so does
 * the space-joined view the quarantine audit scans. snake_case identifiers stay single tokens, so
 * dictionary-word node IDs do not compose a mnemonic; kebab-case parts still
 * split, because the quarantine audit must catch a phrase composed across
 * kebab-case identity fields (a JSON key or value is already its own unit).
 * Other non-letter boundaries catch common accidental separators: newlines,
 * commas, numbered list prefixes. Literal escape sequences (\n, \t, \r) become
 * separators first, so a phrase inside a JSON-stringified blob (a common
 * accidental carrier: embedded logs in summary.json) still tokenizes as a word
 * run instead of gluing the escape letter onto the next word.
 */
function detectMnemonics(text: string): FloorHit[] {
  const tokens = text
    .toLowerCase()
    .replace(/\\[ntr]/g, ' ')
    // Keep identifier runs separate before removing Markdown emphasis edges.
    .replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g, '_')
    .split(/[^a-z_]+/)
    .map((token) => token.replace(/^_+|_+$/g, ''));
  const hits: FloorHit[] = [];
  let runStart = -1;
  for (let i = 0; i <= tokens.length; i += 1) {
    const isWord = i < tokens.length && tokens[i] !== '' && BIP39_SET.has(tokens[i]);
    if (isWord) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1 && i - runStart >= MNEMONIC_MIN_LENGTH) {
        const run = tokens.slice(runStart, i);
        for (const length of MNEMONIC_LENGTHS) {
          for (const stride of MNEMONIC_STRIDES) {
            for (let start = 0; start + (length - 1) * stride < run.length; start += 1) {
              const window: string[] = [];
              for (let k = 0; k < length; k += 1) window.push(run[start + k * stride] ?? '');
              if (hasValidMnemonicChecksum(window)) {
                hits.push({ kind: 'srp', fingerprint: fingerprint(window.join(' ')) });
              }
            }
          }
        }
      }
      runStart = -1;
    }
  }
  return hits;
}

/** Text that is one JSON object or array, where quotes are string boundaries. */
function isJsonDocument(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null;
  } catch {
    // Not JSON: quotes stay ordinary separators, the stricter reading, so a
    // parse failure never narrows recovery-phrase detection.
    return false;
  }
}

/**
 * Fence each string literal of a JSON document that holds several words with
 * `_` markers, so a phrase does not run out of it into the next key or value.
 * Single-word strings still compose, so a mnemonic stored as a word array stays
 * one run. The markers sit outside the literals, so the unescape passes keep
 * them, and escaped content inside one literal (JSON-in-JSON) still composes.
 */
function fenceJsonStringUnits(text: string): string {
  return text.replace(JSON_STRING_LITERAL, (literal) =>
    literal.startsWith('"') && (literal.replace(/\\[ntr]/g, ' ').match(/[a-z]+/gi)?.length ?? 0) > 1
      ? ` _ ${literal} _ `
      : literal,
  );
}

/**
 * The raw text plus up to two unescape passes, so single- and double-JSON-
 * escaped content (accidental JSON-in-JSON carriers) still matches. Deeper
 * nesting is out of the cooperative-producer scope.
 */
function unescapeVariants(text: string): string[] {
  const variants = [text];
  let current = text;
  for (let depth = 0; depth < 2; depth += 1) {
    const next = unescapeOnce(current);
    if (next === current) break;
    variants.push(next);
    current = next;
  }
  return variants;
}

/**
 * A BIP-39 mnemonic carries its own checksum: of its 11 bits per word, the last
 * length/3 bits are the leading bits of SHA-256 over the rest (the entropy).
 */
function hasValidMnemonicChecksum(words: readonly string[]): boolean {
  const bits = words
    .map((word) => (BIP39_INDEX.get(word) ?? 0).toString(2).padStart(11, '0'))
    .join('');
  const checksumLength = words.length / 3;
  const entropyBits = bits.slice(0, bits.length - checksumLength);
  const entropy = Buffer.alloc(entropyBits.length / 8);
  for (let byte = 0; byte < entropy.length; byte += 1) {
    entropy[byte] = Number.parseInt(entropyBits.slice(byte * 8, byte * 8 + 8), 2);
  }
  const digest = createHash('sha256').update(entropy).digest();
  const expected = [...digest]
    .map((byte) => byte.toString(2).padStart(8, '0'))
    .join('')
    .slice(0, checksumLength);
  return bits.slice(-checksumLength) === expected;
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

  // Farm patterns arrive from config: matchAll requires the global flag, so a
  // non-global pattern is re-created with /g instead of throwing mid-scan.
  const normalizedExtras = extraPatterns.map(({ kind, pattern }) =>
    pattern.global
      ? { kind, pattern }
      : { kind, pattern: new RegExp(pattern.source, `${pattern.flags}g`) },
  );

  const variants = unescapeVariants(text);
  // Recovery-phrase runs read the same passes over the fenced document, so no
  // unescaped view lets a run cross from one JSON string into the next.
  const mnemonicVariants = isJsonDocument(text)
    ? unescapeVariants(fenceJsonStringUnits(text))
    : variants;

  // First-wins on a fingerprint: when two rules match the SAME bytes (e.g. our
  // hand-authored `github-token` and gitleaks' `github-pat`), the earlier rule's
  // kind label stands. Detection order is hand-authored first, so our labels
  // remain authoritative where coverage overlaps - the BLOCK is identical either
  // way; only the reported `kind` differs.
  const record = (hit: FloorHit): void => {
    if (!byFingerprint.has(hit.fingerprint)) byFingerprint.set(hit.fingerprint, hit);
  };

  for (const variant of mnemonicVariants) {
    for (const hit of detectMnemonics(variant)) record(hit);
  }
  for (const variant of variants) {
    for (const hit of detectCookies(variant)) record(hit);
    // Hand-authored floor + farm extras + the ported gitleaks vendor ruleset.
    // Gitleaks rules run through the SAME unescape variants and are UNION-only
    // additions - they widen coverage, never narrow the hand-authored floor.
    for (const { kind, pattern } of [...FLOOR_PATTERNS, ...normalizedExtras, ...GITLEAKS_RULES]) {
      for (const match of variant.matchAll(pattern)) {
        record({ kind, fingerprint: fingerprint(match[0]) });
      }
    }
  }

  return [...byFingerprint.values()];
}
