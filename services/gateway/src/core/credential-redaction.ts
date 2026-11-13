// Records keep credential names, never their values. Only real credential
// values are replaced: a secret-looking value assigned to a credential name, or
// a known provider token shape anywhere in text.

export const REDACTED_CREDENTIAL = '[REDACTED]';

/** The suffix that marks a credential, e.g. LITELLM_API_KEY, GH_TOKEN or GITHUB_PAT. Names that
 * only end near one (API_KEY_INDEX, KEY_ID, MAX_TOKENS, GIT_CONFIG_KEY_0) are not credentials. */
const CREDENTIAL_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT|CREDENTIALS)$/;

/** Provider token shapes, redacted wherever they occur. */
const PROVIDER_TOKEN = new RegExp(
  '(?<![A-Za-z0-9_-])(?:' +
    [
      'sk-ant-[A-Za-z0-9_-]{16,}',
      'sk-[A-Za-z0-9_-]{17,}',
      'gh[pos]_[A-Za-z0-9]{20,}',
      'github_pat_[A-Za-z0-9_]{20,}',
      'ATATT[A-Za-z0-9_=-]{20,}',
      'xox[bp]-[A-Za-z0-9-]{10,}',
      'AKIA[0-9A-Z]{16}(?![0-9A-Z])',
      'glpat-[A-Za-z0-9_-]{20,}',
      'npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])',
      'AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])',
      'hf_[A-Za-z0-9]{30,}',
      'xai-[A-Za-z0-9]{20,}',
      'fw_[A-Za-z0-9]{20,}',
    ].join('|') +
    ')',
  'g',
);
const PROVIDER_TOKEN_VALUE = new RegExp(`^${PROVIDER_TOKEN.source}$`);
/** A repo slug or file path such as org/repo or ~/dir/file. */
const SLUG_OR_PATH = /^[~.]?\/?[\w.-]+(?:\/[\w.-]+)+\/?$/;

// NAME=value, NAME: value or "NAME": "value" with a literal value: shellQuote's
// '…'\''…' form, a quoted string without expansions, or a bare word. A `$NAME`
// reference is not a value.
const ASSIGNMENT =
  /(?<![A-Za-z0-9_$])(["']?)([A-Z_][A-Z0-9_]*)\1(=|[ \t]*:[ \t]*)('[^']*'(?:\\''[^']*')*|"(?:[^"\\$`]|\\.)*"|[^\s;&|()<>'"`$\\,}\]]+)/g;

export function isCredentialName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name) && CREDENTIAL_NAME.test(name);
}

function unquote(value: string): string {
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll(`'\\''`, "'");
  if (value.startsWith('"')) return value.slice(1, -1).replace(/\\(.)/g, '$1');
  return value;
}

/** Names that only ever hold a credential, e.g. DB_PASSWORD or WEBHOOK_SECRET. */
const STRONG_CREDENTIAL_NAME = /(?:^|_)(?:SECRET|PASSWORD|PASSWD)$/;

/**
 * True for a literal that looks like a secret: a provider shape, or 16+ characters mixing at least
 * two of lowercase, uppercase and digits. Under a `_SECRET`/`_PASSWORD`/`_PASSWD` name any 12+
 * character value counts, so single-case passwords and passphrases are caught. References,
 * placeholders such as `local`, numbers, URLs and single-case slugs such as `metamask-extension`
 * or `org/repo` are not secrets.
 */
export function isSecretValue(value: string, name = ''): boolean {
  if (PROVIDER_TOKEN_VALUE.test(value)) return true;
  if (value.includes('$') || /\s/.test(value) || SLUG_OR_PATH.test(value)) return false;
  if (STRONG_CREDENTIAL_NAME.test(name))
    return value.length >= 12 && !/^\d+$/.test(value) && !/^[a-z][\w+.-]*:\/\//i.test(value);
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((pattern) => pattern.test(value)).length;
  return value.length >= 16 && classes >= 2;
}

/** Replaces credential values in text (shell lines, prose, embedded JSON). */
export function redactCommandCredentials(command: string): { text: string; count: number } {
  let count = 0;
  const assigned = command.replace(
    ASSIGNMENT,
    (match, quote: string, name: string, separator: string, value: string) => {
      if (!isCredentialName(name) || !isSecretValue(unquote(value), name)) return match;
      count += 1;
      const marker =
        separator === '=' || !/^["']/.test(value)
          ? REDACTED_CREDENTIAL
          : `${value[0]}${REDACTED_CREDENTIAL}${value[0]}`;
      return `${quote}${name}${quote}${separator}${marker}`;
    },
  );
  const text = assigned.replace(PROVIDER_TOKEN, () => {
    count += 1;
    return REDACTED_CREDENTIAL;
  });
  return { text, count };
}

/** Step output fields that hold shell command lines. */
export const COMMAND_OUTPUT_KEYS = ['launchCommand', 'cliCommand', 'failedCommand'] as const;

/** Redacts command fields of a step's outputs in place; returns the number of values replaced. */
export function redactStepOutputCommands(outputs: Record<string, unknown> | undefined): number {
  let count = 0;
  for (const key of COMMAND_OUTPUT_KEYS) {
    const value = outputs?.[key];
    if (typeof value !== 'string') continue;
    const redacted = redactCommandCredentials(value);
    if (redacted.count) outputs![key] = redacted.text;
    count += redacted.count;
  }
  return count;
}
