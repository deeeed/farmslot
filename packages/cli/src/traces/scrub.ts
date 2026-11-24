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

  private apply(text: string, token: (rule: ScrubRule) => string): string {
    let out = text;
    for (const { rule, pattern, replace } of this.rules) {
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

  private value(value: unknown): unknown {
    if (typeof value === 'string') return this.apply(value, (rule) => `[REDACTED:${rule}]`);
    if (Array.isArray(value)) return value.map((entry) => this.value(entry));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.value(entry)]),
      );
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
          try {
            return JSON.stringify(this.value(JSON.parse(trimmed)));
          } catch {
            // Not JSON after all: scrubbed as text below.
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
