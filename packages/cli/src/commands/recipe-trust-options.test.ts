import assert from 'node:assert/strict';
import test from 'node:test';

import { Command } from 'commander';

import { registerRecipeCommand } from './recipe.js';

test('recipe run exposes exact-plan trust controls', () => {
  const program = new Command();
  registerRecipeCommand(program);

  const recipe = program.commands.find((command) => command.name() === 'recipe');
  const run = recipe?.commands.find((command) => command.name() === 'run');
  assert.ok(run);
  assert.deepEqual(
    run.options
      .flatMap((option) => (option.long ? [option.long] : []))
      .filter((option) => option.startsWith('--source-') || option === '--approve-plan')
      .sort(),
    ['--approve-plan', '--source-digest', '--source-kind', '--source-name', '--source-trust'],
  );
});
