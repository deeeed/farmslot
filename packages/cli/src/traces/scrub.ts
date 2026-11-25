// ADR-039 Amendment 10: the replacing scrubber run trace export applies to every file it writes.
// Best effort, not a guarantee: an export stays on the local machine.
import { FLOOR_PATTERNS, GITLEAKS_RULES } from '@farmslot/handoff/scrub';

export type ScrubRule =
  | 'secret-value'
  | 'publication-pattern'
  | 'private-key'
  | 'email'
  | 'dsn'
  | 'secret-variable'
  | 'username'
  | 'home-path'
  | 'machine';

export interface ScrubInputs {
  /** Exact configured secret values (provider environment, tokens, LiteLLM keys). */
  secretValues: string[];
  /** The local user and every pool host's SSH user. */
  usernames: string[];
  /** Pool machine names. */
  machines: string[];
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const global = (pattern: RegExp) =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

/** Hex of 64+ characters labelled as a key: a key-like name on the line, or assigned the value. */
const LABELLED_KEY =
  /((?:private[_-]?key|privateKey|secret|seed|mnemonic)[^\n]{0,40}?[:=>"'\s]{1,4})(0x)?[0-9a-fA-F]{64,}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DSN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+(?::[^\s@/"']*)?@[^\s/"']+/gi;
const SECRET_VARIABLE =
  /\b([A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|PASSWORD))(\s*[=:]\s*["']?)([^\s"']+)/g;
const HOME = /(\/Users\/|\/home\/)([^/\s"'\\]+)/g;

/** A JSON key whose string value is a secret: replaced whole, whatever the value looks like. */
const SECRET_KEY =
  /(?:^|[_-])(?:token|secret|password|passwd)$|(?:privatekey|private_key|secretkey|secret_key|secret|password|passwd|mnemonic|seedphrase|seed_phrase|apikey|api_key|accesskey|access_key|accesstoken|access_token|refreshtoken|refresh_token|authtoken|auth_token|clientsecret|client_secret)$/i;
const KEY_IS_PRIVATE_KEY = /private|mnemonic|seed/i;
/** JSON keys Farmslot writes digests and SHAs under: never redacted by the publication patterns. */
const OWN_DIGEST_KEYS = new Set([
  'sha256',
  'diffSha256',
  'templateSha256',
  'bundleDigest',
  'startRef',
  'dispatchHead',
  'finalHead',
  'prHead',
  'mergeSha',
]);

/**
 * Blocks whose `data` is a base64 image: Pi and Claude content (`image`), and an Anthropic
 * image `source` (`base64`).
 */
const IMAGE_BLOCK_TYPES = new Set(['image', 'base64']);
const BASE64 = /^[A-Za-z0-9+/=]*$/;
/** A whole value that is an inline image, as OpenAI-style `image_url` content carries it. */
const BASE64_IMAGE_URL = /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]*$/;

/** Farmslot's own digests and SHA fields are kept: they are not secrets. */
const OWN_DIGEST =
  /("(?:sha256|diffSha256|templateSha256|bundleDigest|startRef|dispatchHead|finalHead|prHead|mergeSha|ref)"\s*:\s*")|sha256:/;

export class TraceScrubber {
  readonly counts = new Map<ScrubRule, number>();
  private readonly rules: { rule: ScrubRule; pattern: RegExp; replace?: string }[];

  constructor(inputs: ScrubInputs) {
    const values = inputs.secretValues.filter((value) => value.length >= 8);
    this.rules = [
      ...(values.length
        ? [
            {
              rule: 'secret-value' as const,
              pattern: new RegExp(values.map(escape).join('|'), 'g'),
            },
          ]
        : []),
      ...[...FLOOR_PATTERNS, ...GITLEAKS_RULES].map(({ pattern }) => ({
        rule: 'publication-pattern' as const,
        pattern: global(pattern),
      })),
      { rule: 'private-key', pattern: LABELLED_KEY, replace: '$1{token}' },
      { rule: 'dsn', pattern: DSN },
      { rule: 'email', pattern: EMAIL },
      { rule: 'secret-variable', pattern: SECRET_VARIABLE, replace: '$1$2{token}' },
      ...(inputs.usernames.length
        ? [
            {
              rule: 'username' as const,
              pattern: new RegExp(`\\b(?:${inputs.usernames.map(escape).join('|')})\\b`, 'g'),
            },
          ]
        : []),
      { rule: 'home-path', pattern: HOME, replace: '~' },
      ...(inputs.machines.length
        ? [
            {
              rule: 'machine' as const,
              pattern: new RegExp(`\\b(?:${inputs.machines.map(escape).join('|')})\\b`, 'g'),
              replace: '<machine>',
            },
          ]
        : []),
    ];
  }

  private count(rule: ScrubRule, n: number) {
    if (n) this.counts.set(rule, (this.counts.get(rule) ?? 0) + n);
  }

  private apply(
    text: string,
    token: (rule: ScrubRule) => string,
    options: { ownDigest?: boolean } = {},
  ): string {
    let out = text;
    for (const { rule, pattern, replace } of this.rules) {
      if (options.ownDigest && (rule === 'publication-pattern' || rule === 'private-key')) continue;
      pattern.lastIndex = 0;
      let n = 0;
      out = out.replace(pattern, (...match: string[]) => {
        const whole = match[0];
        const offset = Number(match[match.length - 2]);
        // A digest Farmslot wrote itself is left in place.
        if (
          rule === 'publication-pattern' &&
          OWN_DIGEST.test(out.slice(Math.max(0, offset - 40), offset))
        )
          return whole;
        n += 1;
        if (!replace) return token(rule);
        return replace
          .replace(/\$(\d)/g, (_, i: string) => match[Number(i)] ?? '')
          .replace('{token}', token(rule));
      });
      this.count(rule, n);
    }
    return out;
  }

  /**
   * One JSON value, scrubbed with its key in view: a value under a secret-like key is replaced
   * whole (labelled rules cannot see the key once a value is scrubbed alone), keys are scrubbed,
   * and Farmslot's own digest fields skip the publication patterns.
   */
  private value(value: unknown, key?: string): unknown {
    const token = (rule: ScrubRule) => `[REDACTED:${rule}]`;
    if (typeof value === 'string') {
      if (BASE64_IMAGE_URL.test(value)) return value;
      if (key && value.length >= 6 && SECRET_KEY.test(key)) {
        const rule: ScrubRule = KEY_IS_PRIVATE_KEY.test(key) ? 'private-key' : 'secret-variable';
        this.count(rule, 1);
        return token(rule);
      }
      return this.apply(value, token, { ownDigest: key !== undefined && OWN_DIGEST_KEYS.has(key) });
    }
    if (Array.isArray(value)) return value.map((entry) => this.value(entry, key));
    if (value && typeof value === 'object') {
      // An image's base64 payload is kept as is. The text patterns cannot see into an image,
      // a match inside base64 would only corrupt it, and scanning megabytes of screenshots
      // with every publication pattern took an export minutes per run.
      const image = IMAGE_BLOCK_TYPES.has((value as { type?: unknown }).type as string);
      // No prototype: `constructor` or `__proto__` keys are plain own keys, as in the input.
      const out: Record<string, unknown> = Object.create(null);
      for (const [entryKey, entry] of Object.entries(value)) {
        if (image && entryKey === 'data' && typeof entry === 'string' && BASE64.test(entry)) {
          out[entryKey] = entry;
          continue;
        }
        const base = this.apply(entryKey, token);
        let scrubbedKey = base;
        // Two keys redacted to the same token stay apart instead of overwriting each other.
        for (let n = 2; Object.hasOwn(out, scrubbedKey); n++) scrubbedKey = `${base}#${n}`;
        out[scrubbedKey] = this.value(entry, entryKey);
      }
      return out;
    }
    return value;
  }

  /**
   * File contents, line by line. A JSON line is scrubbed value by value and written back, so
   * JSONL stays valid even when a pattern would span quotes; other lines are scrubbed as text.
   */
  text(content: string): string {
    return content
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            parsed = undefined;
          }
          if (parsed !== undefined) {
            const scrubbed = JSON.stringify(this.value(parsed));
            // A line with nothing redacted keeps its bytes (and numbers past 2^53 their digits).
            return scrubbed === JSON.stringify(parsed) ? line : scrubbed;
          }
        }
        return this.apply(line, (rule) => `[REDACTED:${rule}]`);
      })
      .join('\n');
  }

  /** File names take a token without brackets or a colon. */
  name(fileName: string): string {
    return this.apply(fileName, (rule) => `REDACTED-${rule}`).replace(/[/\\]/g, '-');
  }

  report(): Record<string, number> {
    return Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}
