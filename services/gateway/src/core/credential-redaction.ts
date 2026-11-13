// Records keep credential names, never their values.

export const REDACTED_CREDENTIAL = '[REDACTED]';

/** Environment-style names that carry a credential, e.g. LITELLM_API_KEY or GH_TOKEN. */
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(?:^|_)PAT$/;

// NAME=value with a literal value: shellQuote's '…'\''…' form, a double-quoted
// string without expansions, or a bare word. A `$NAME` reference is not a value.
const ASSIGNMENT =
  /(?<![A-Za-z0-9_$])([A-Z_][A-Z0-9_]*)=('[^']*'(?:\\''[^']*')*|"(?:[^"\\$`]|\\.)*"|[^\s;&|()<>'"`$\\]+)/g;

export function isCredentialName(name: string): boolean {
  return (
    /^[A-Z_][A-Z0-9_]*$/.test(name) &&
    CREDENTIAL_NAME.test(name) &&
    !/^GIT_CONFIG_KEY_\d+$/.test(name)
  );
}

/** Replaces literal values assigned to credential names in a shell command. */
export function redactCommandCredentials(command: string): { text: string; count: number } {
  let count = 0;
  const text = command.replace(ASSIGNMENT, (match, name: string, value: string) => {
    if (!isCredentialName(name) || value === REDACTED_CREDENTIAL) return match;
    count += 1;
    return `${name}=${REDACTED_CREDENTIAL}`;
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
