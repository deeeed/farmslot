import { Command } from 'commander';

import { registerDoctorCommand } from './doctor.js';
import { registerRecipeCommand } from './recipe.js';

/** The same registrations supply help, shell completion and the published reference. */
export function renderRecipeCliReference(): string {
  const program = new Command().name('farmslot');
  registerRecipeCommand(program);
  registerDoctorCommand(program);
  const lines = [
    '# Recipe CLI reference',
    '',
    'Generated from the command registration used by `--help` and shell completion. Do not edit this page by hand.',
    '',
    'Start with [Recipe concepts](./recipe-concepts.md). Run `farmslot --help` for global options.',
    '',
    "Project-specific launch and execution flags come from the selected provider's strict command grammar. The host validates those flags before constructing the provider.",
    '',
  ];
  function append(command: Command, parents: string[]): void {
    command.configureHelp({ helpWidth: 88 });
    const words = [...parents, command.name()];
    lines.push(
      `## ${words.join(' ')}`,
      '',
      '```text',
      command.helpInformation().trimEnd(),
      '```',
      '',
    );
    for (const child of command.commands) append(child, words);
  }
  for (const command of program.commands) append(command, ['farmslot']);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function recipeCliReferenceSitePage(): string {
  return `---\ntitle: Recipe CLI reference\n---\n\n${renderRecipeCliReference()}`;
}
