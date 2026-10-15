#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isMainModule, renderTimingSummary, runTimedSteps } from './lib/step-timing.mjs';

/** The repository quality job and workers call this same check list. */
export const CI_PARITY_STEPS = [
  ['format', ['yarn', 'format:check']],
  ['lint', ['yarn', 'lint']],
  ['workspace structure', ['yarn', 'quality:structure']],
  ['workspace changelogs', ['yarn', 'quality:changelogs']],
  ['method matrix', ['yarn', 'quality:method-matrix']],
  ['authorization', ['yarn', 'quality:authorization']],
  ['retired scripts', ['yarn', 'quality:retired-scripts']],
  ['import boundaries', ['yarn', 'quality:imports']],
  [
    'model transport module load',
    [
      'env',
      'TSX_TSCONFIG_PATH=services/gateway/tsconfig.json',
      'node',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "await import('./.agents/skills/tmux-model-driver/scripts/native-evidence.mjs')",
    ],
  ],
  ['large files', ['yarn', 'quality:large-files']],
  ['project hook conformance', ['yarn', 'test:project-hooks']],
];

/** Scope only the directory and ignore rules used by the CI format guard. */
export function ciParitySteps(files, cwd) {
  const formatFiles = files?.filter(
    (file) => file.startsWith('apps/command-center/') && existsSync(path.join(cwd, file)),
  );
  const format = formatFiles?.length
    ? [
        'yarn',
        '--cwd',
        'apps/command-center',
        'exec',
        'prettier',
        '--check',
        '--ignore-unknown',
        ...formatFiles.map((file) => path.join(cwd, file)),
      ]
    : CI_PARITY_STEPS[0][1];
  return [['format', format], ...CI_PARITY_STEPS.slice(1)];
}

function changedFiles(cwd) {
  const eventFile = process.env.GITHUB_EVENT_PATH;
  const event =
    eventFile && existsSync(eventFile) ? JSON.parse(readFileSync(eventFile, 'utf8')) : null;
  const base = event?.pull_request?.base?.sha ?? 'origin/main';
  const diff = spawnSync('git', ['diff', '--name-only', '-z', base], { cwd, encoding: 'utf8' });
  if (diff.status !== 0) return null; // Shallow/standalone checkouts get the full format guard.
  const untracked = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
  });
  if (untracked.status !== 0) throw new Error('Cannot enumerate local CI inputs');
  return [...new Set((diff.stdout + untracked.stdout).split('\0').filter(Boolean))];
}

if (isMainModule(import.meta.url)) {
  const cwd = process.cwd();
  const { records, failure } = runTimedSteps(ciParitySteps(changedFiles(cwd), cwd), {
    prefix: 'ci-local',
    spawn: spawnSync,
    cwd,
  });
  for (const line of renderTimingSummary({ prefix: 'ci-local', records, failure }))
    console.log(line);
  process.exitCode = failure?.status ?? 0;
}
