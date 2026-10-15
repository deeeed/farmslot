import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Argument, type Command, InvalidArgumentError, Option } from 'commander';

import type { TaskExecutionInput } from '@farmslot/agent-runtime';
import type { CliOptions } from '@farmslot/recipe-cli/harness';

import { errorEnvelope } from '../envelope.js';
import { OutputContext } from '../output.js';

import {
  collectRecipeOption,
  projectCommandInvocation,
  projectRecipeHostOptions,
  recipeProjectOptions,
} from './recipe-project.js';

const hostOnly = new Set([
  '--target',
  '--projects-dir',
  '--authorize-provider',
  '--adapter',
  '--app',
  '--slot',
  '--device',
  '--watcher-port',
  '--cdp-port',
  '--runtime-dir',
  '--library',
]);

/** Preserve task helper flags while consuming root binding controls once. */
export function taskHelperArgv(command: Command, includePlatform = false): string[] {
  const argv = projectCommandInvocation(command, {}).argv;
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!.split('=', 1)[0]!;
    if (hostOnly.has(flag) || (!includePlatform && flag === '--platform')) {
      if (!argv[index]!.includes('=')) index += 1;
    } else forwarded.push(argv[index]!);
  }
  return forwarded;
}

function cliInstallation(): Omit<TaskExecutionInput, 'bindingIdentity' | 'inputs'> {
  const packageRoot = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  const workspace = path.resolve(packageRoot, '../..');
  const workspaceInstall = fs.existsSync(path.join(workspace, 'yarn.lock'));
  if (workspaceInstall && !fs.existsSync(path.join(workspace, 'DEPLOYED-REVISION.json'))) {
    throw Object.assign(
      new Error(
        'Task pinning requires the immutable CLI distribution, not a full development workspace.',
      ),
      {
        code: 'TASK_INSTALL_UNSUPPORTED',
        exitCode: 2,
        userAction: 'Use the CLI snapshot installed through the supported node CLI installation.',
      },
    );
  }
  return {
    packageRoot,
    distributionRoot: workspaceInstall ? workspace : packageRoot,
    executable: path.join(packageRoot, 'bin/farmslot.mjs'),
  };
}

export async function runTaskCommand(
  action: 'init' | 'verify' | 'mark' | 'closeout',
  command: Command,
): Promise<number> {
  const shared = await import('@farmslot/recipe-cli/harness');
  const options: CliOptions = { ...command.optsWithGlobals() };
  const argv = taskHelperArgv(command, action === 'init');
  const taskDir = path.resolve(command.args[0]!);
  if (action === 'init' && fs.existsSync(path.join(taskDir, 'artifacts/harness-provenance.json'))) {
    shared.verifySelectedTask(taskDir);
    throw shared.usageError(
      'This task is already initialized. Use farmslot task verify to resume its retained tooling.',
    );
  }
  if (action !== 'init') {
    const receipt = shared.verifySelectedTask(taskDir);
    if (action === 'verify') {
      process.stdout.write(
        options.json ? `${JSON.stringify(receipt, null, 2)}\n` : `${receipt.resolvedExecutable}\n`,
      );
      return 0;
    }
    if (receipt.bindingIdentity === null) return shared.handleChecklist([action, ...argv]);
    return shared.withTaskProjectHost(
      await projectRecipeHostOptions('task', undefined, options),
      taskDir,
      async ({ provider }) => {
        const policy = provider.commandOptions?.task;
        if (!policy || !Array.isArray(policy.stepGates))
          throw shared.usageError('The selected provider does not declare task gates.');
        return shared.handleChecklist([action, ...argv], policy);
      },
    );
  }
  const host = await projectRecipeHostOptions('task', undefined, options);
  host.deferOutput = false;
  // Absence of a project permits an explicit static template. A resolved broken
  // project, ambiguous selection or unauthorized provider never takes this path.
  try {
    await shared.resolveProjectContext(host);
  } catch (error) {
    if (
      options.project !== undefined ||
      !(error instanceof shared.ProjectBindingError) ||
      error.code !== 'PROJECT_NOT_FOUND' ||
      error.selectedProject !== undefined
    )
      throw error;
    return shared.handleTaskInit(
      ['init', ...argv],
      {},
      {
        ...cliInstallation(),
        bindingIdentity: null,
        inputs: [],
        selectedConfiguration: '{"identity":null}',
      },
    );
  }
  return shared.withProjectRecipeHost(host, async (selected) => {
    const policy = selected.provider.commandOptions?.task;
    if (!policy || !Array.isArray(policy.stepGates))
      throw shared.usageError('The selected provider does not declare task gates.');
    return shared.handleTaskInit(
      ['init', ...argv],
      policy,
      await shared.projectTaskExecution(selected, cliInstallation()),
    );
  });
}

export function registerTaskCommand(program: Command): void {
  const task = program
    .command('task')
    .description('Initialize, verify and close tasks with retained tooling');
  const init = recipeProjectOptions(
    task
      .command('init')
      .description('Create a task from an execution template')
      .argument('<task-dir>'),
  )
    .option('--target <path>', 'Product checkout')
    .requiredOption('--flow <flow>', 'Execution flow')
    .requiredOption('--template <id>', 'Execution template')
    .requiredOption('--title <text>', 'Task title')
    .addOption(
      new Option('--run-mode <mode>', 'Execution mode').choices([
        'interactive',
        'autonomous',
        'validation',
      ]),
    );
  for (const [flag, description] of [
    ['--domain <name>', 'Domain selection'],
    ['--task-text <text>', 'Task description'],
    ['--task-file <path>', 'Read the task description'],
    ['--ticket <key>', 'Ticket identity'],
    ['--source-ref <ref>', 'Task source'],
    ['--surface <surface>', 'Task surface'],
    ['--repo <owner/name>', 'Repository identity'],
    ['--attempt-id <id>', 'Attempt identity'],
    ['--task-dir-label <label>', 'Rendered task directory'],
    ['--mode-preamble <text>', 'Mode instructions'],
    ['--addendum-file <path>', 'Authored task addendum'],
    ['--project-worker <path>', 'Project worker templates'],
    ['--project-name <name>', 'Project template identity'],
    ['--package-templates <path>', 'Package template catalog'],
    ['--package-id <id>', 'Package template identity'],
  ])
    init.option(flag!, description!);
  for (const [flag, description] of [
    ['--dir <path>', 'Template source'],
    ['--domain-dir <name=path>', 'Domain templates'],
    ['--var <key=value>', 'Template variable'],
    ['--acceptance <criterion>', 'Acceptance criterion'],
  ])
    init.option(flag!, description!, collectRecipeOption, []);
  const verify = task
    .command('verify')
    .description('Verify retained task tooling without running it')
    .argument('<task-dir>');
  const mark = recipeProjectOptions(
    task
      .command('mark')
      .description('Mark task progress through provider gates')
      .argument('<task-dir>')
      .addArgument(
        new Argument('<step>').argParser((step: string) => {
          if (
            ['start', 'complete', 'no-change', 'blocked', 'sub', 'wait', 'resume'].includes(step) ||
            (Number.isInteger(Number(step)) && Number(step) >= 1)
          )
            return step;
          throw new InvalidArgumentError(
            'Use start, a positive step number, complete, no-change, blocked, sub, wait or resume.',
          );
        }),
      )
      .argument('[args...]'),
  );
  for (const flag of [
    '--reason <text>',
    '--checklist <path>',
    '--signal <path>',
    '--who <name>',
    '--report <path>',
  ])
    mark.option(flag);
  for (const flag of [
    '--skip-learnings',
    '--mark-last',
    '--already-fixed',
    '--no-review',
    '--skip-checklist',
    '--allow-empty',
  ])
    mark.option(flag);
  for (const flag of ['--step <number>', '--from <path>']) mark.option(flag);
  mark.option('--var <key=value>', 'Subtask template variable', collectRecipeOption, []);
  const closeout = recipeProjectOptions(
    task
      .command('closeout')
      .description('Stage task closeout under project policy')
      .argument('<task-dir>'),
  ).option('--share', 'Explicitly share the staged learning package');
  for (const flag of ['--config <path>', '--destination <path>', '--metadata <json>'])
    closeout.option(flag);
  for (const [action, cmd] of [
    ['init', init],
    ['verify', verify],
    ['mark', mark],
    ['closeout', closeout],
  ] as const) {
    cmd.action(async (...args: unknown[]) => {
      const actual = args.at(-1);
      if (actual !== cmd) throw new Error('Task command registration mismatch.');
      try {
        process.exitCode = await runTaskCommand(action, cmd);
      } catch (error) {
        new OutputContext(true).writeJson(errorEnvelope(`task.${action}`, error));
        process.exitCode =
          error instanceof Error && 'exitCode' in error && typeof error.exitCode === 'number'
            ? error.exitCode
            : 1;
      }
    });
  }
}
