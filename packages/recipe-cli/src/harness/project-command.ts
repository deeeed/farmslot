import {
  type CommandContract,
  type ContractedCommand,
  validatePublicInvocation,
} from './command-contract.js';
import { CliError, type CliOptions, optionFlag, parseArgs, type ParsedArgs } from './parse-args.js';

const previewOptions = ['plan', 'list', 'describe', 'help'] as const;

/** Shared by the host and provider so previews cannot acquire execution authority. */
export function isRecipeExecution(command: string | undefined, options: CliOptions = {}): boolean {
  return (
    (command === 'run' || command === 'call') &&
    !previewOptions.some((flag) => optionFlag(options, flag))
  );
}

export interface ProjectCommandInvocation {
  argv: readonly string[];
  contract: CommandContract;
}

/** A provider extends the existing CLI grammar; host controls keep their declared meaning. */
export function parseProjectInvocation(
  command: string,
  invocation: ProjectCommandInvocation,
  providerCommands: readonly ContractedCommand[] = [],
): ParsedArgs {
  const extension = providerCommands.find((entry) => entry.name === command);
  const contract = {
    ...invocation.contract,
    options: { ...extension?.contract.options, ...invocation.contract.options },
  };
  for (const mode of previewOptions) {
    const flag = `--${mode}`;
    if (!(flag in invocation.contract.options)) delete contract.options[flag];
  }
  const error = validatePublicInvocation(
    [command, ...invocation.argv],
    [
      {
        name: command,
        example: `farmslot recipe ${command} --help`,
        contract,
      },
    ],
  );
  if (error) throw Object.assign(new CliError(error.message, 2), error);
  return parseArgs([...invocation.argv], { optionSpecs: contract.options });
}
