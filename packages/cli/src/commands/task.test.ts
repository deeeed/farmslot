import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Command } from 'commander';

import { commandTree } from './completion.js';
import { registerRecipeQualityCommand } from './recipe-quality.js';
import { registerReviewCommand } from './review.js';
import { registerTaskCommand, taskHelperArgv } from './task.js';

function cli(): Command {
  const program = new Command().exitOverride().option('--json');
  program.configureOutput({ writeOut() {}, writeErr() {} });
  registerTaskCommand(program);
  registerReviewCommand(program);
  registerRecipeQualityCommand(program.command('recipe'));
  return program;
}

test('canonical helper names appear in grammar and generated completions', () => {
  const tree = commandTree(cli());
  assert.deepEqual(
    tree.find((entry) => entry.name === 'task')?.subs.map((entry) => entry.name),
    ['init', 'verify', 'mark', 'closeout'],
  );
  assert.deepEqual(
    tree.find((entry) => entry.name === 'review')?.subs.map((entry) => entry.name),
    ['checklist', 'domain'],
  );
  assert.deepEqual(
    tree
      .find((entry) => entry.name === 'recipe')
      ?.subs.find((entry) => entry.name === 'quality')
      ?.subs.map((entry) => entry.name),
    ['build', 'plan', 'advise', 'advisor-status'],
  );
  assert.equal(
    tree.some((entry) => ['checklist', 'recipe-quality'].includes(entry.name)),
    false,
  );
});

test('invalid marker and unknown flags refuse before reading a task or provider', async () => {
  await assert.rejects(
    cli().parseAsync(['task', 'mark', '/missing/task', 'invalid'], { from: 'user' }),
    { code: 'commander.invalidArgument' },
  );
  await assert.rejects(
    cli().parseAsync(['task', 'mark', '/missing/task', '1', '--unsupported'], { from: 'user' }),
    { code: 'commander.unknownOption' },
  );
  await assert.rejects(
    cli().parseAsync(['task', 'init', '/missing/task', '--title', 'Task'], { from: 'user' }),
    { code: 'commander.missingMandatoryOptionValue' },
  );
});

test('mark forwarding preserves explicit negation and consumes binding controls', async () => {
  for (const negate of [false, true]) {
    const program = cli();
    const mark = program.commands
      .find((entry) => entry.name() === 'task')!
      .commands.find((entry) => entry.name() === 'mark')!;
    let forwarded: string[] = [];
    mark.action(() => {
      forwarded = taskHelperArgv(mark);
    });
    await program.parseAsync(
      [
        '--json',
        'task',
        'mark',
        'task-dir',
        'complete',
        '--adapter',
        'headless',
        '--mark-last',
        ...(negate ? ['--no-self-review'] : []),
      ],
      { from: 'user' },
    );
    assert.deepEqual(forwarded, [
      'task-dir',
      'complete',
      '--mark-last',
      ...(negate ? ['--no-self-review'] : []),
      '--json',
    ]);
  }
});
