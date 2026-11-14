import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isMainModule } from './lib/step-timing.mjs';
import { verifyBuildReceipt } from './ci-build-state.mjs';
import {
  commandKey,
  monolithicCommands,
  quoteCommand,
  taskId,
  testFiles,
} from './full-ci-commands.mjs';
import { assertCoverage, inDocsPipeline, wordsOf, wrapper } from './full-ci-coverage.mjs';
import { balance } from './pr-ci-plan.mjs';
export { assertCoverage } from './full-ci-coverage.mjs';

function taskSeconds(task) {
  if (task.label === 'companion tests') return 72;
  if (task.label === 'recipe operational gates') return 106;
  if (task.label?.includes('panel') || task.label === 'offline-first reads') return 130;
  if (
    task.command.includes('check-farmslot-package-readiness.mjs') &&
    task.command.includes('--pack')
  )
    return 120;
  if (task.command.includes('run-tsx-tests.mjs') && task.cwd === 'apps/command-center') return 140;
  if (task.command.includes('check-recipe-operational')) return 110;
  if (task.command.includes('tsc')) return 25;
  return 12;
}

export function createFullPlan(root, durations = {}) {
  const baseline = monolithicCommands(root);
  const unique = [...new Map(baseline.map((task) => [commandKey(task), task])).values()];
  const desktop = unique.filter((task) => task.platform === 'darwin');
  const node24 = unique.filter((task) => task.node === 24);
  const commands = unique.filter(
    (task) => task.platform === 'linux' && task.node === 22 && !task.buildOwner,
  );
  const wrappers = commands.map((task) => ({ task, runner: wrapper(task, root) }));
  const gateway = wrappers.find(
    ({ task, runner }) =>
      runner && task.workspace === '@farmslot/gateway' && runner.parsed.roots.includes('src'),
  );
  if (!gateway) throw new Error('Missing full gateway test command');
  const gatewayFiles = testFiles(gateway.task, root);
  const coveredGateway = new Set(
    gatewayFiles.map((file) => JSON.stringify([file, gateway.runner.profile])),
  );
  const jobs = balance(gatewayFiles, 8, (file) => durations[file] ?? 1500).map((files, index) => {
    const cwd = path.relative(root, gateway.runner.cwd).split(path.sep).join('/');
    const args = [
      'node',
      'scripts/quality/run-tsx-tests.mjs',
      '--cwd',
      cwd,
      '--tsconfig',
      gateway.runner.parsed.tsconfig ?? 'tsconfig.json',
      '--workers',
      String(gateway.runner.parsed.workers ?? 4),
      ...(gateway.runner.parsed.nodeTest ? ['--node-test'] : []),
      ...files.map((file) => path.posix.relative(cwd, file)),
    ];
    return {
      id: `gateway-${index + 1}`,
      tasks: [{ ...gateway.task, cwd: '.', command: quoteCommand(args), words: args }],
    };
  });
  const remaining = commands
    .filter((task) => {
      const runner = wrapper(task, root);
      return (
        !runner ||
        !testFiles(task, root).every((file) =>
          coveredGateway.has(JSON.stringify([file, runner.profile])),
        )
      );
    })
    .map((task) =>
      task.command.includes('scripts/quality/check-farmslot-package-readiness.mjs') &&
      task.command.includes('--pack')
        ? { ...task, command: `${task.command} --prebuilt` }
        : task,
    );
  const packages = new Map();
  for (const task of remaining.filter((entry) => entry.workspace)) {
    const list = packages.get(task.workspace) ?? [];
    list.push(task);
    packages.set(task.workspace, list);
  }
  const packageWeights = {
    '@farmslot/adapter-web': 141,
    '@farmslot/cli': 110,
    '@farmslot/agent-runtime': 96,
    '@farmslot/node': 76,
    '@farmslot/protocol': 76,
    '@farmslot/recipe-cli': 74,
    '@farmslot/recipe-runner': 70,
    '@farmslot/adapter-rn': 42,
  };
  for (const [index, group] of balance(
    [...packages],
    4,
    ([name]) => packageWeights[name] ?? 20,
  ).entries())
    jobs.push({ id: `workspaces-${index + 1}`, tasks: group.flatMap(([, tasks]) => tasks) });
  const guards = remaining.filter((task) => !task.workspace);
  const pipelines = new Map();
  for (const task of guards) {
    const key = inDocsPipeline(task) ? 'generated docs' : (task.label ?? task.command);
    const pipeline = pipelines.get(key) ?? [];
    pipeline.push(task);
    pipelines.set(key, pipeline);
  }
  for (const [index, groups] of balance([...pipelines.values()], 3, (tasks) =>
    tasks.reduce((sum, task) => sum + taskSeconds(task), 0),
  ).entries()) {
    const tasks = groups.flat();
    jobs.push({
      id: `guards-${index + 1}`,
      lint: tasks.some((task) => task.command.includes('check-eslint-ratchet')),
      tasks,
    });
  }
  const withIds = (tasks) =>
    tasks.map((task) => {
      const runner = wrapper(task, root);
      return {
        ...task,
        id: taskId(task),
        words: wordsOf(task),
        ...(runner
          ? {
              reportCwd: path.relative(root, runner.cwd).split(path.sep).join('/') || '.',
              tests: testFiles(task, root).sort(),
            }
          : {}),
      };
    });
  const plan = {
    version: 1,
    mode: 'full',
    prerequisites: true,
    jobs: jobs.map((job) => ({ ...job, tasks: withIds(job.tasks) })),
    desktop: { id: 'desktop', tasks: withIds(desktop) },
  };
  const compatibilityOwner = plan.jobs.find((job) => job.id === 'guards-3');
  compatibilityOwner.tasks.push(...withIds(node24));
  compatibilityOwner.node24 = true;
  plan.coverage = assertCoverage(plan, root);
  return plan;
}

if (isMainModule(import.meta.url)) {
  const root = process.cwd();
  verifyBuildReceipt(root);
  const durations = JSON.parse(readFileSync('scripts/quality/ci-test-durations.json', 'utf8'));
  const plan = createFullPlan(root, durations);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (sha.status !== 0) throw new Error(sha.stderr);
  plan.sha = sha.stdout.trim();
  mkdirSync('.cache/full-ci', { recursive: true });
  writeFileSync('.cache/full-ci/plan.json', `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync('.cache/full-ci/coverage.json', `${JSON.stringify(plan.coverage, null, 2)}\n`);
  if (process.env.FULL_CI_BASELINE_REF) {
    const { compareParentCoverage } = await import('./full-ci-parent-coverage.mjs');
    const comparison = compareParentCoverage(
      root,
      process.env.FULL_CI_BASELINE_REF,
      plan.coverage.matrix,
    );
    writeFileSync(
      '.cache/full-ci/coverage-parent.json',
      `${JSON.stringify(comparison, null, 2)}\n`,
    );
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify({ include: plan.jobs.map(({ id, lint, node24 }) => ({ id, lint: Boolean(lint), node24: Boolean(node24) })) })}\n`,
    );
  console.log(
    JSON.stringify({
      jobs: plan.jobs.length,
      files: plan.coverage.baseline.files.length,
      guards: plan.coverage.baseline.guards.length,
      diff: plan.coverage.diff,
    }),
  );
}
