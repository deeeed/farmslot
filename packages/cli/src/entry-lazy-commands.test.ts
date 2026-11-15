import assert from 'node:assert/strict';
import test from 'node:test';

import { Command } from 'commander';

import { registerCommands } from './entry-commands.js';
import { LAZY_COMMANDS } from './entry-lazy-commands.js';

/** A command's whole surface: name, aliases, arguments, options and subcommands, recursively. */
function shape(command: Command): unknown {
  return {
    name: command.name(),
    aliases: command.aliases(),
    description: command.description(),
    arguments: command.registeredArguments.map((argument) => [argument.name(), argument.required]),
    options: command.options.map((option) => [option.flags, option.defaultValue]),
    commands: command.commands.map(shape),
  };
}

test('a lazily registered command is exactly the command the full registration builds', async () => {
  const full = new Command();
  registerCommands(full);
  for (const [name, register] of Object.entries(LAZY_COMMANDS)) {
    const alone = new Command();
    await register(alone);
    assert.deepEqual(
      alone.commands.map((command) => command.name()),
      [name],
      `${name} registers only itself`,
    );
    const registered = full.commands.find((command) => command.name() === name);
    assert.ok(registered, `${name} is part of the full registration`);
    assert.deepEqual(shape(alone.commands[0]!), shape(registered), `${name} has the same surface`);
  }
});
