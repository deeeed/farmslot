// ADR-039 Amendment 10: the replacing scrubber run trace export applies to every file it writes.
// A basic, fast backstop over text: a small fixed set of obvious secret shapes, each pattern
// anchored on a literal, a run boundary or a bounded prefix, so its cost grows with the input,
// not its square.
// Full scanning is the operator's scan hook (FARMSLOT_TRACE_SCAN_HOOK), off by default.
// Best effort, not a guarantee: an export stays on the local machine.

export type ScrubRule =
  | 'secret-value'
  | 'token'
  | 'private-key'
  | 'email'
  | 'dsn'
  | 'secret-variable'
  | 'username'
  | 'home-path'
  | 'machine';

/** The rules in the order they apply, as the exported README lists them. */
export const SCRUB_RULES: readonly ScrubRule[] = [
  'secret-value',
  'token',
  'private-key',
  'dsn',
  'email',
  'secret-variable',
  'username',
  'home-path',
  'machine',
];

export interface ScrubInputs {
  /** Exact configured secret values (provider environment, tokens, LiteLLM keys). */
  secretValues: string[];
  /** The local user and every pool host's SSH user. */
  usernames: string[];
  /** Pool machine names. */
  machines: string[];
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Credentials whose shape names them: GitHub, OpenAI and Anthropic, Slack, AWS access keys,
 * Google API keys, GitLab, npm, JWTs and bearer tokens. Each starts with a fixed prefix.
 */
const TOKEN = new RegExp(
  [
    String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{22,}`,
    String.raw`\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`,
    String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`,
    String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}`,
    String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
    String.raw`\bnpm_[A-Za-z0-9]{36}`,
    // Not inside a run of token characters (`-` makes a word boundary there, and a failed JWT
    // tried at each one would rescan the rest of the run); a leading `-`, as in a diff, is fine.
    String.raw`(?<![A-Za-z0-9_]|[A-Za-z0-9_-]-)eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
    String.raw`\b[Bb]earer +[A-Za-z0-9._~+/-]{20,}=*`,
  ].join('|'),
  'g',
);
/**
 * A PEM private key: from its header to its end line, whatever lies between (escaped or real
 * newlines, line numbers, diff markers), when the end comes within 16 KB and before another
 * header. With no end in reach (cut output, such as `head -3 key.pem`), the header and the
 * base64 chunks that follow it: each a run of 16+ base64 characters after a short separator of
 * newlines, escaped newlines, spaces, line numbers or diff and quote markers. Prose, blank
 * lines and short words survive. The bounds, and the stop at the next header, keep it linear.
 */
const PEM_KEY =
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----(?:(?:(?!-----BEGIN )[\s\S]){0,16384}?-----END [A-Z ]{0,30}PRIVATE KEY-----|(?:(?:\\[rn]|[\s\d+>|-]){1,16}[A-Za-z0-9+/=]{16,})+)?/g;
/** Hex of 64+ characters labelled as a key: a key-like name on the line, or assigned the value. */
const LABELLED_KEY =
  /((?:private[_-]?key|privateKey|secret|seed|mnemonic)[^\n]{0,40}?[:=>"'\s]{1,4})(0x)?[0-9a-fA-F]{64,}/gi;
// Starts only where a run of address characters starts. The domain is labels and a TLD, taken
// in a lookahead and then consumed whole, so a failed address is not retried inside the run.
const EMAIL = /(?<![\w.%+-])[\w.%+-]+@(?=((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}))\1/g;
// The scheme is bounded, so a long run of scheme characters is not rescanned from each start.
const DSN = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/"']+(?::[^\s@/"']*)?@[^\s/"']+/gi;
const SECRET_VARIABLE =
  /\b([A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|PASSWORD))(\s*[=:]\s*["']?)([^\s"']+)/g;
const HOME = /(\/Users\/|\/home\/)([^/\s"'\\]+)/g;

/**
 * An image's base64 payload is not text, so it is not scanned: a match inside it would only
 * corrupt the image. A value counts as one only with an `image/*` type beside it (or in its
 * data URL) and an image format's own leading bytes (PNG, JPEG, GIF, WebP).
 */
const IMAGE_BASE64 = /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)[A-Za-z0-9+/]*={0,2}$/;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,/;
/** Payload keys of Pi and Claude `image` blocks, Anthropic sources and Claude's `file` copy. */
const IMAGE_PAYLOAD_KEYS = new Set(['data', 'base64']);
const IMAGE_TYPE_KEYS = ['mimeType', 'media_type', 'mediaType', 'type'];
const isImageType = (value: unknown) => typeof value === 'string' && value.startsWith('image/');

/** A JSON key whose string value is a secret: replaced whole, whatever the value looks like. */
const SECRET_KEY =
  /(?:^|[_-])(?:token|secret|password|passwd)$|(?:privatekey|private_key|secretkey|secret_key|secret|password|passwd|mnemonic|seedphrase|seed_phrase|apikey|api_key|accesskey|access_key|accesstoken|access_token|refreshtoken|refresh_token|authtoken|auth_token|clientsecret|client_secret)$/i;
const KEY_IS_PRIVATE_KEY = /private|mnemonic|seed/i;
/** JSON keys Farmslot writes digests and SHAs under: never redacted by the key rules. */
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
      { rule: 'token', pattern: TOKEN },
      { rule: 'private-key', pattern: PEM_KEY },
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
      // A digest Farmslot wrote itself is left in place.
      if (options.ownDigest && rule === 'private-key') continue;
      pattern.lastIndex = 0;
      let n = 0;
      out = out.replace(pattern, (...match: string[]) => {
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
   * and Farmslot's own digest fields skip the private-key rules.
   */
  private value(value: unknown, key?: string, imageType = false): unknown {
    const token = (rule: ScrubRule) => `[REDACTED:${rule}]`;
    if (typeof value === 'string') {
      if (key && value.length >= 6 && SECRET_KEY.test(key)) {
        const rule: ScrubRule = KEY_IS_PRIVATE_KEY.test(key) ? 'private-key' : 'secret-variable';
        this.count(rule, 1);
        return token(rule);
      }
      const image = IMAGE_DATA_URL.exec(value);
      if (image && IMAGE_BASE64.test(value.slice(image[0].length))) return value;
      if (imageType && key && IMAGE_PAYLOAD_KEYS.has(key) && IMAGE_BASE64.test(value)) return value;
      return this.apply(value, token, { ownDigest: key !== undefined && OWN_DIGEST_KEYS.has(key) });
    }
    if (Array.isArray(value)) return value.map((entry) => this.value(entry, key));
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      const typed = entries.some(
        ([entryKey, entry]) => IMAGE_TYPE_KEYS.includes(entryKey) && isImageType(entry),
      );
      // No prototype: `constructor` or `__proto__` keys are plain own keys, as in the input.
      const out: Record<string, unknown> = Object.create(null);
      for (const [entryKey, entry] of entries) {
        const base = this.apply(entryKey, token);
        let scrubbedKey = base;
        // Two keys redacted to the same token stay apart instead of overwriting each other.
        for (let n = 2; Object.hasOwn(out, scrubbedKey); n++) scrubbedKey = `${base}#${n}`;
        out[scrubbedKey] = this.value(entry, entryKey, typed);
      }
      return out;
    }
    return value;
  }

  /**
   * File contents, line by line. A JSON line is scrubbed value by value and written back, so
   * JSONL stays valid even when a pattern would span quotes. Other lines are scrubbed as text,
   * after a pass over each stretch of them for PEM keys that span lines: every line a key covers
   * becomes a marker, so the line count stays the same.
   */
  text(content: string): string {
    const out: string[] = [];
    let block: string[] = [];
    const flush = () => {
      if (!block.length) return;
      let keys = 0;
      const keyed = block.join('\n').replace(PEM_KEY, (key) => {
        keys += 1;
        return key
          .split('\n')
          .map(() => '[REDACTED:private-key]')
          .join('\n');
      });
      this.count('private-key', keys);
      for (const line of keyed.split('\n'))
        out.push(this.apply(line, (rule) => `[REDACTED:${rule}]`));
      block = [];
    };
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined) {
          flush();
          const scrubbed = JSON.stringify(this.value(parsed));
          // A line with nothing redacted keeps its bytes (and numbers past 2^53 their digits).
          out.push(scrubbed === JSON.stringify(parsed) ? line : scrubbed);
          continue;
        }
      }
      block.push(line);
    }
    flush();
    return out.join('\n');
  }

  /** File names take a token without brackets or a colon. */
  name(fileName: string): string {
    return this.apply(fileName, (rule) => `REDACTED-${rule}`).replace(/[/\\]/g, '-');
  }

  report(): Record<string, number> {
    return Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}
