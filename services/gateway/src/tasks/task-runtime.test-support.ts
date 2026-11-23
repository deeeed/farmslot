import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

import { projectWorkerTemplateSource, selectExecutionTemplate } from '@farmslot/agent-runtime';
import type { TaskRuntimeRequest } from '@farmslot/slot-config/task-runtime';

// One installed CLI fixture shared by task-runtime.test.ts and the CLI/thread
// parity suite in task-runtime-parity.live.ts.
export const repo = path.resolve(import.meta.dirname, '../../../..');
export const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-runtime-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
export const distribution = path.join(root, 'installation');
const cli = path.join(distribution, 'packages/cli');
fs.mkdirSync(cli, { recursive: true });
fs.writeFileSync(path.join(distribution, 'yarn.lock'), '');
fs.writeFileSync(path.join(distribution, 'DEPLOYED-REVISION.json'), '{}');
fs.mkdirSync(path.join(distribution, 'packages/agent-runtime'), { recursive: true });
fs.copyFileSync(
  path.join(repo, 'packages/agent-runtime/package.json'),
  path.join(distribution, 'packages/agent-runtime/package.json'),
);
for (const directory of ['src', 'scripts', 'bin'])
  fs.cpSync(
    path.join(repo, 'packages/agent-runtime', directory),
    path.join(distribution, 'packages/agent-runtime', directory),
    { recursive: true, filter: (file) => !file.endsWith('.test.ts') },
  );
fs.cpSync(path.join(repo, 'packages/cli/src'), path.join(cli, 'src'), {
  recursive: true,
  filter: (file) => !file.endsWith('.test.ts'),
});
fs.cpSync(path.join(repo, 'packages/cli/bin'), path.join(cli, 'bin'), { recursive: true });
fs.writeFileSync(
  path.join(cli, 'package.json'),
  JSON.stringify({ name: '@farmslot/cli', version: '1.0.0', type: 'module' }),
);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
const config = JSON.parse(fs.readFileSync(path.join(repo, 'packages/cli/tsconfig.json'), 'utf8'));
config.extends = path.join(repo, 'apps/command-center/tsconfig.base.json');
for (const key of Object.keys(config.compilerOptions.paths))
  config.compilerOptions.paths[key] = config.compilerOptions.paths[key].map((entry: string) =>
    path.resolve(repo, 'packages/cli', entry),
  );
config.compilerOptions.paths['@farmslot/agent-runtime'] = [
  path.join(distribution, 'packages/agent-runtime/src/index.ts'),
];
config.compilerOptions.paths['@farmslot/agent-runtime/*'] = [
  path.join(distribution, 'packages/agent-runtime/src/*'),
];
fs.writeFileSync(path.join(cli, 'tsconfig.json'), JSON.stringify(config));
export const checkout = path.join(root, 'checkout');
const project = path.join(root, 'projects/fixture');
fs.mkdirSync(checkout);
fs.mkdirSync(path.join(root, 'pool'));
fs.mkdirSync(path.join(project, 'templates/worker'), { recursive: true });
fs.writeFileSync(
  path.join(project, 'project.json'),
  JSON.stringify({ name: 'fixture', task_dir: 'tasks', execution_templates: { sources: [] } }),
);
fs.writeFileSync(path.join(project, 'templates/worker/dev.md'), '# Task\n\n- [ ] Observe\n');
fs.writeFileSync(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    project: 'fixture',
    platform: 'cli',
    slots: [{ id: 'fixture-1', repo: checkout }],
  }),
);
const selected = selectExecutionTemplate({
  sources: [projectWorkerTemplateSource('fixture', path.join(project, 'templates'))],
  flow: 'dev',
  platform: 'cli',
});
export const taskDir = path.join(checkout, 'tasks/dev/task');
export const env: NodeJS.ProcessEnv = {
  ...process.env,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
};
delete env.FARMSLOT_ROOT;
export const request: TaskRuntimeRequest = {
  action: 'verify',
  taskPath: taskDir,
  supportDir: root,
  env: {},
};
export function wireRequest() {
  const file = path.join(taskDir, '.task-init-00000000-0000-4000-8000-000000000000.json');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      slotId: 'fixture-1',
      binding: 'static',
      task: {
        taskDir,
        flow: 'dev',
        platform: 'cli',
        task: { title: 'Thread parity', sourceKind: 'text', acceptanceCriteria: ['Keep bytes'] },
        handoff: {
          surface: 'farmslot',
          project: 'fixture',
          attemptId: 'attempt',
          startedAt: '2026-11-08T00:00:00Z',
        },
      },
      template: {
        sourceId: selected.entry.sourceId,
        id: selected.entry.id,
        sha256: selected.entry.sha256,
        selectionReason: selected.reason,
      },
    }),
  );
  return file;
}
// The source CLI transpiles its whole module graph on every start (TSX_DISABLE_CACHE in
// packages/cli/bin/farmslot.mjs), which on a slow CI runner passed 4 s (run 42513053470).
// These deadlines catch hangs, not slowness.
const SPAWN = 15_000;
export const CASE = 20_000;
export function cliRun(args: string[], environment: NodeJS.ProcessEnv = env) {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [path.join(cli, 'bin/farmslot.mjs'), '--json', ...args],
    {
      env: environment,
      cwd: checkout,
      encoding: 'utf8',
      timeout: SPAWN,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
    ms: performance.now() - started,
  };
}
