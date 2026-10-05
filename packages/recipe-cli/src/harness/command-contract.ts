// The strict public grammar a host CLI checks before commander can consume a
// typo as a value: each public command declares its options and positionals,
// and a mismatch becomes a stable, machine-readable usage error.
import { harnessHost } from './host.js';
import { closest } from './suggest.js';

export type CliUsageErrorCode =
  | 'CLI_UNKNOWN_COMMAND'
  | 'CLI_UNKNOWN_OPTION'
  | 'CLI_MISSING_OPTION_VALUE'
  | 'CLI_INVALID_OPTION_VALUE'
  | 'CLI_MISSING_POSITIONAL'
  | 'CLI_INVALID_POSITIONAL'
  | 'CLI_EXCESS_POSITIONAL'
  | 'CLI_UNEXPECTED_PASSTHROUGH';

export interface OptionSpec {
  kind: 'boolean' | 'value' | 'optional-value';
  /** Accepted values; a function is read at validation time (registry or library ids). */
  choices?: readonly string[] | (() => readonly string[]);
}

export interface PositionalSpec {
  label: string;
  choices?: readonly string[];
  pattern?: RegExp;
  validate?: (value: string) => boolean;
  validDescription?: string;
}

export interface CliUsageError {
  code: CliUsageErrorCode;
  command: string;
  message: string;
  userAction: string;
}

/** The failures a command's `refine` hook builds, with the command's own recovery lines. */
export interface ContractFailures {
  usage(code: CliUsageErrorCode, message: string): CliUsageError;
  missingPositional(message: string): CliUsageError;
}

export interface CommandContract {
  usage?: string;
  options: Readonly<Record<string, OptionSpec>>;
  positionals?: readonly PositionalSpec[];
  minimumPositionals?: number;
  variadic?: PositionalSpec;
  requiredUnless?: readonly string[];
  noPositionalsWith?: readonly string[];
  leadingPositionals?: number;
  allowPassthrough?: boolean;
  /** A sub-grammar another tool validates: skip this contract entirely. */
  bypass?: (tokens: readonly string[]) => boolean;
  /** Command-specific rules, after option parsing and before the positional checks. */
  refine?: (
    positionals: readonly string[],
    seenOptions: ReadonlySet<string>,
    fail: ContractFailures,
  ) => CliUsageError | null;
  /** The recovery for a missing positional, given the command's example. */
  missingPositionalAction?: (example: string) => string;
}

/** A command the contract knows: its name, aliases, example and grammar. */
export interface ContractedCommand {
  name: string;
  aliases?: readonly string[];
  example: string;
  contract: CommandContract;
}

export interface ContractValidationOptions {
  /** Retired option spellings and the option that replaces each, for the suggestion. */
  replacedOptions?: Readonly<Record<string, string>>;
}

export const booleanOption = (): OptionSpec => ({ kind: 'boolean' });
export const valueOption = (choices?: OptionSpec['choices']): OptionSpec => ({
  kind: 'value',
  ...(choices ? { choices } : {}),
});
export const optionalValueOption = (choices?: OptionSpec['choices']): OptionSpec => ({
  kind: 'optional-value',
  ...(choices ? { choices } : {}),
});
export const contractOptions = (
  ...groups: Record<string, OptionSpec>[]
): Readonly<Record<string, OptionSpec>> =>
  Object.assign({}, ...groups) as Record<string, OptionSpec>;

/**
 * The usage error for `argv`, or null when it is valid. `commands` is the
 * host's public table; its order is the order "Valid commands" lists.
 */
export function validatePublicInvocation(
  argv: readonly string[],
  commands: readonly ContractedCommand[],
  validation: ContractValidationOptions = {},
): CliUsageError | null {
  const host = harnessHost().name;
  const examples = Object.fromEntries(commands.map((command) => [command.name, command.example]));
  const token = argv[0];
  if (!token || token === '--help' || token === '-h' || token === '--version' || token === '-v')
    return null;
  const resolved = resolveContractedCommand(token, commands);
  if (!resolved) {
    const suggestion = closest(token, publicCommandTokens(commands));
    if (token.startsWith('-')) {
      return {
        code: 'CLI_UNKNOWN_OPTION',
        command: host,
        message: `unknown top-level option '${token}'. Valid top-level options: --help, --version.`,
        userAction: actionFor(token, closest(token, ['--help', '--version']), `${host} --help`),
      };
    }
    return {
      code: 'CLI_UNKNOWN_COMMAND',
      command: token,
      message: `unknown command '${token}'. Valid commands: ${commands.map((command) => command.name).join(', ')}.`,
      userAction: actionFor(
        token,
        suggestion,
        suggestion
          ? exampleFor(host, resolveContractedCommand(suggestion, commands)?.name, examples)
          : `${host} --help`,
      ),
    };
  }

  const { name, contract } = resolved;
  const tokens = argv.slice(1);
  if (contract.bypass?.(tokens)) return null;
  const fail: ContractFailures = {
    usage: (code, message) => usageFailure(host, code, name, message, examples),
    missingPositional: (message) =>
      missingPositionalFailure(host, name, message, contract, examples),
  };
  const positionals: string[] = [];
  const seenOptions = new Set<string>();
  const validOptions = Object.keys(contract.options);

  for (let index = 0; index < tokens.length; index += 1) {
    const argument = tokens[index] ?? '';
    if (argument === '--') {
      if (!contract.allowPassthrough) {
        return fail.usage(
          'CLI_UNEXPECTED_PASSTHROUGH',
          'this command does not accept `--` passthrough.',
        );
      }
      break;
    }
    if (!argument.startsWith('-') || argument === '-') {
      positionals.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const optionName = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    const spec = contract.options[optionName];
    if (!spec) {
      const suggestion =
        validation.replacedOptions?.[optionName] ?? closest(optionName, validOptions);
      return {
        code: 'CLI_UNKNOWN_OPTION',
        command: name,
        message: `unknown option '${optionName}'.`,
        userAction: actionFor(optionName, suggestion, exampleFor(host, name, examples)),
      };
    }
    seenOptions.add(optionName);
    if (spec.kind === 'boolean') {
      if (inlineValue !== undefined) {
        return fail.usage(
          'CLI_INVALID_OPTION_VALUE',
          `${optionName} is a flag and does not take a value.`,
        );
      }
      continue;
    }

    if (spec.kind === 'optional-value' && inlineValue === undefined) continue;
    const optionValue = inlineValue ?? tokens[index + 1];
    const nextTokenIsOption =
      inlineValue === undefined &&
      (optionValue === '-h' || optionValue === '--' || optionValue?.startsWith('--'));
    if (
      optionValue === undefined ||
      (spec.kind === 'value' && optionValue === '') ||
      nextTokenIsOption
    ) {
      return fail.usage('CLI_MISSING_OPTION_VALUE', `${optionName} requires a value.`);
    }
    if (inlineValue === undefined) index += 1;
    const choices = typeof spec.choices === 'function' ? spec.choices() : spec.choices;
    if (choices && !choices.includes(optionValue)) {
      const suggestion = closest(optionValue, choices);
      return {
        code: 'CLI_INVALID_OPTION_VALUE',
        command: name,
        message: `${optionName} must be ${formatChoiceList(choices)}; received '${optionValue}'.`,
        userAction: actionFor(optionValue, suggestion, exampleFor(host, name, examples)),
      };
    }
  }

  if (seenOptions.has('--help') || seenOptions.has('-h')) return null;
  const refined = contract.refine?.(positionals, seenOptions, fail);
  if (refined) return refined;
  if (
    contract.leadingPositionals &&
    !contract.requiredUnless?.some((option) => seenOptions.has(option)) &&
    tokens
      .slice(0, contract.leadingPositionals)
      .some((argument) => !argument || argument.startsWith('-'))
  ) {
    const missing = contract.positionals?.[0]?.label ?? 'argument';
    return fail.missingPositional(`${name} requires <${missing}> first.`);
  }
  const forbiddingOption = contract.noPositionalsWith?.find((option) => seenOptions.has(option));
  if (forbiddingOption && positionals.length > 0) {
    return fail.usage(
      'CLI_EXCESS_POSITIONAL',
      `${forbiddingOption} does not accept positional '${positionals[0]}'.`,
    );
  }
  const minimum = contract.requiredUnless?.some((option) => seenOptions.has(option))
    ? 0
    : (contract.minimumPositionals ?? 0);
  if (positionals.length < minimum) {
    const missingSpec = contract.positionals?.[positionals.length];
    const missing = missingSpec?.label ?? 'argument';
    const valid = missingSpec?.choices?.length
      ? ` Choose one: ${missingSpec.choices.join('|')}.`
      : '';
    const usage = contract.usage ? ` Usage: ${contract.usage}.` : '';
    return fail.missingPositional(`missing required <${missing}>.${valid}${usage}`);
  }

  const fixed = contract.positionals ?? [];
  for (let index = 0; index < Math.min(positionals.length, fixed.length); index += 1) {
    if (invalidPositional(positionals[index] ?? '', fixed[index]))
      return positionalFailure(host, name, positionals[index] ?? '', fixed[index], examples);
  }
  if (positionals.length > fixed.length && !contract.variadic) {
    const unexpected = positionals[fixed.length] ?? '';
    return fail.usage(
      'CLI_EXCESS_POSITIONAL',
      `unexpected positional '${unexpected}'; this command accepts ${formatPositionals(contract)}.`,
    );
  }
  if (contract.variadic) {
    for (const positional of positionals.slice(fixed.length)) {
      if (invalidPositional(positional, contract.variadic)) {
        return positionalFailure(host, name, positional, contract.variadic, examples);
      }
    }
  }
  return null;
}

/** Every public command name and alias, in table order. */
export function publicCommandTokens(commands: readonly ContractedCommand[]): string[] {
  return commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
}

function resolveContractedCommand(
  token: string,
  commands: readonly ContractedCommand[],
): ContractedCommand | undefined {
  return (
    commands.find((command) => command.name === token) ??
    commands.find((command) => command.aliases?.includes(token))
  );
}

function usageFailure(
  host: string,
  code: CliUsageErrorCode,
  command: string,
  message: string,
  examples: Readonly<Record<string, string>>,
): CliUsageError {
  return {
    code,
    command,
    message,
    userAction: `Try: ${exampleFor(host, command, examples)}. Inspect options: ${host} ${command} --help`,
  };
}

function missingPositionalFailure(
  host: string,
  command: string,
  message: string,
  contract: CommandContract,
  examples: Readonly<Record<string, string>>,
): CliUsageError {
  if (contract.missingPositionalAction) {
    return {
      code: 'CLI_MISSING_POSITIONAL',
      command,
      message,
      userAction: contract.missingPositionalAction(exampleFor(host, command, examples)),
    };
  }
  return usageFailure(host, 'CLI_MISSING_POSITIONAL', command, message, examples);
}

function positionalFailure(
  host: string,
  command: string,
  received: string,
  spec: PositionalSpec,
  examples: Readonly<Record<string, string>>,
): CliUsageError {
  const valid =
    spec.validDescription ??
    (spec.choices
      ? spec.choices.join(', ')
      : spec.pattern || spec.validate
        ? `a valid <${spec.label}>`
        : `<${spec.label}>`);
  const suggestion = spec.choices ? closest(received, spec.choices) : undefined;
  return {
    code: 'CLI_INVALID_POSITIONAL',
    command,
    message: `invalid <${spec.label}> '${received}'. Valid values: ${valid}.`,
    userAction: actionFor(received, suggestion, exampleFor(host, command, examples)),
  };
}

function invalidPositional(value: string, spec: PositionalSpec | undefined): boolean {
  if (!spec) return true;
  if (spec.choices && !spec.choices.includes(value)) return true;
  if (spec.validate && !spec.validate(value)) return true;
  return Boolean(spec.pattern && !spec.pattern.test(value));
}

function formatChoiceList(choices: readonly string[]): string {
  if (choices.length === 1) return choices[0] ?? '';
  if (choices.length === 2) return `${choices[0]} or ${choices[1]}`;
  return `${choices.slice(0, -1).join(', ')}, or ${choices[choices.length - 1]}`;
}

function formatPositionals(contract: CommandContract): string {
  const fixed = (contract.positionals ?? []).map((spec) => `<${spec.label}>`);
  if (contract.variadic) fixed.push(`[<${contract.variadic.label}> ...]`);
  return fixed.length > 0 ? fixed.join(' ') : 'no positionals';
}

function actionFor(received: string, suggestion: string | undefined, example: string): string {
  return `${suggestion ? `Did you mean '${suggestion}' instead of '${received}'? ` : ''}Try: ${example}`;
}

function exampleFor(
  host: string,
  command: string | undefined,
  examples: Readonly<Record<string, string>>,
): string {
  return command ? (examples[command] ?? `${host} ${command} --help`) : `${host} --help`;
}
