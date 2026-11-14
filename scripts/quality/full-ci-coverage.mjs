import path from 'node:path';

import { buildProjects } from './ci-build-state.mjs';
import { commandKey, monolithicCommands, shellCommands, testFiles } from './full-ci-commands.mjs';
import { parseArgs } from './run-tsx-tests.mjs';

export function wordsOf(task) {
  const commands = shellCommands(task.command);
  if (commands.length !== 1) throw new Error(`Full CI task must be atomic: ${task.command}`);
  return commands[0].words;
}

function docsCleanCheck(task) {
  const words = wordsOf(task);
  return words[0] === 'git' && words[1] === 'diff' && words.includes('apps/docs/docs');
}

export function inDocsPipeline(task) {
  return (
    task.label === 'docs build' ||
    task.cwd === 'apps/docs' ||
    task.cwd.startsWith('apps/docs/') ||
    docsCleanCheck(task)
  );
}

export function wrapper(task, root) {
  const words = wordsOf(task);
  const index = words.findIndex((word) => word.endsWith('run-tsx-tests.mjs'));
  if (index === -1) return null;
  const parsed = parseArgs(words.slice(index + 1));
  const cwd = path.resolve(root, task.cwd, parsed.cwd ?? '.');
  return {
    words,
    index,
    parsed,
    cwd,
    profile: JSON.stringify([
      task.platform,
      task.node,
      path.relative(root, cwd),
      path.relative(root, path.resolve(cwd, parsed.tsconfig ?? 'tsconfig.json')),
      parsed.nodeTest,
      words.slice(0, index).filter((word) => word !== 'node' && word !== 'env'),
      task.env ?? {},
    ]),
  };
}

function prerequisiteTasks(root) {
  return buildProjects(root).map((project) => ({
    node: 22,
    platform: 'linux',
    cwd: project.dir,
    workspace: project.name,
    buildOwner: project.name,
    label: `build ${project.name}`,
    command: `tsc --project ${project.config}`,
    words: ['tsc', '--project', project.config],
  }));
}

function normalize(task) {
  // --prebuilt changes only build ownership. The pack/import/temp-consumer
  // checks remain the original command and require a source-matched receipt.
  if (task.command.includes('scripts/quality/check-farmslot-package-readiness.mjs'))
    return { ...task, command: task.command.replace(/\s+--prebuilt$/, '') };
  return task;
}

export function coverageOf(tasks, root) {
  const files = new Set(),
    guards = new Map(),
    seen = new Set();
  for (const original of tasks) {
    const task = normalize({ ...original, words: wordsOf(original) });
    if (task.buildOwner && task.words.join(' ') === 'rm -rf dist') continue;
    const key = JSON.stringify([commandKey(task), Boolean(task.test)]);
    if (seen.has(key)) continue;
    seen.add(key);
    const runner = wrapper(task, root);
    const profile =
      runner?.profile ?? JSON.stringify([task.platform, task.node, task.cwd, task.env ?? {}]);
    for (const file of testFiles(task, root)) files.add(JSON.stringify([file, profile]));
    if (!runner)
      guards.set(commandKey(task), {
        platform: task.platform,
        node: task.node,
        cwd: task.cwd,
        command: task.command,
      });
  }
  return {
    files: [...files].sort(),
    guards: [...guards.keys()].sort(),
    testFiles: [...new Set([...files].map((entry) => JSON.parse(entry)[0]))].sort(),
    guardCommands: [...guards.values()],
  };
}

export function compareCoverage(baseline, matrix) {
  const difference = (a, b) => {
    const expected = new Set(b);
    return a.filter((value) => !expected.has(value));
  };
  return {
    missingFiles: difference(baseline.files, matrix.files),
    addedFiles: difference(matrix.files, baseline.files),
    missingGuards: difference(baseline.guards, matrix.guards),
    addedGuards: difference(matrix.guards, baseline.guards),
  };
}

export function assertCoverage(plan, root) {
  const tasks = [...plan.jobs.flatMap((job) => job.tasks), ...plan.desktop.tasks];
  const commands = new Set(),
    assignments = new Set();
  for (const task of tasks) {
    const key = commandKey(task);
    if (commands.has(key)) throw new Error(`Duplicate full CI task: ${task.command}`);
    commands.add(key);
    const runner = wrapper(task, root);
    if (runner)
      for (const file of testFiles(task, root)) {
        const assignment = JSON.stringify([file, runner.profile]);
        if (assignments.has(assignment)) throw new Error(`Duplicate full test assignment: ${file}`);
        assignments.add(assignment);
      }
  }
  const docs = plan.jobs.flatMap((job) =>
    job.tasks.filter(inDocsPipeline).map((task) => ({ job: job.id, task })),
  );
  if (new Set(docs.map((entry) => entry.job)).size > 1)
    throw new Error('Generated docs and their clean-tree check must share a checkout');
  const clean = docs.findIndex(({ task }) => docsCleanCheck(task));
  if (clean !== -1 && clean !== docs.length - 1)
    throw new Error('Generated docs clean-tree check must follow the generators and build');
  const baseline = coverageOf([...prerequisiteTasks(root), ...monolithicCommands(root)], root);
  const actual = coverageOf(
    [
      ...(plan.prerequisites ? prerequisiteTasks(root) : []),
      ...plan.jobs.flatMap((job) => job.tasks),
      ...plan.desktop.tasks,
    ],
    root,
  );
  const diff = compareCoverage(baseline, actual);
  if (Object.values(diff).some((values) => values.length))
    throw new Error(`Full CI coverage differs: ${JSON.stringify(diff)}`);
  return { baseline, matrix: actual, diff };
}

export function monolithicCoverage(root, options) {
  return coverageOf([...prerequisiteTasks(root), ...monolithicCommands(root, options)], root);
}
