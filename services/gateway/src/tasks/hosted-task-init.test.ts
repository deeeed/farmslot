import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { projectWorkerTemplateSource, selectExecutionTemplate } from '@farmslot/agent-runtime';

import type { SlotVars } from '../core/config.js';
import * as realExec from '../core/exec.js';
import { remapRemoteFarmRefs } from '../node-support/remote-command.js';

import * as realRuntime from './agent-runtime-script.js';

let fixtureFarm = '';
let executedOptions: realExec.ExecOnSlotOptions | undefined;
let executionCount = 0;
function fixtureSlot(root: string): SlotVars {
  return {
    slotId: 'fixture-1',
    host: 'localhost',
    machine: 'local',
    platform: 'cli',
    sshUser: 'test',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: root,
    remoteRepo: root,
    session: 'fixture-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    projectName: 'fixture',
    resourceVars: {},
  };
}
mock.module('./agent-runtime-script.js', {
  namedExports: { ...realRuntime, farmslotDirectoryForSlot: async () => fixtureFarm },
});

mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    execOnSlot: async (_slot: SlotVars, _command: string, options?: realExec.ExecOnSlotOptions) => {
      executedOptions = options;
      executionCount += 1;
      return { exitCode: 2, stdout: 'TASK_INIT_PARTIAL', stderr: '' };
    },
  },
});
const fresh: string = './hosted-task-init.js?partial-preservation';
const { initializeHostedTaskOnSlot, hostedTaskCommand } = (await import(
  fresh
)) as typeof import('./hosted-task-init.js');

test('partial initialization refuses before any gateway sidecar replaces retained files', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'partial-hosted-task-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixtureFarm = root;
  const gateway = path.join(root, 'gateway');
  const worker = path.join(root, 'worker');
  const templates = path.join(root, 'templates');
  fs.mkdirSync(path.join(templates, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(templates, 'worker/dev.md'), '# Task\n- [ ] Observe\n');
  const selected = selectExecutionTemplate({
    sources: [projectWorkerTemplateSource('fixture', templates)],
    flow: 'dev',
    platform: 'cli',
  });
  for (const directory of [gateway, worker]) {
    fs.mkdirSync(path.join(directory, 'inputs'), { recursive: true });
    for (const file of ['mark', 'CHECKLIST.md', 'inputs/handoff.json'])
      fs.writeFileSync(
        path.join(directory, file),
        directory === worker ? 'keep-owned' : 'old-gateway',
      );
  }
  fs.writeFileSync(
    path.join(worker, 'checklist-target.json'),
    '{"checklist":"REVIEW.md","signal":"REVIEW-SIGNAL.json"}',
  );
  fs.writeFileSync(path.join(worker, 'inputs/recipe-binding.json'), '{}');
  const files = [
    'mark',
    'CHECKLIST.md',
    'inputs/handoff.json',
    'checklist-target.json',
    'inputs/recipe-binding.json',
  ];
  const before = files.map((file) => fs.readFileSync(path.join(worker, file), 'utf8'));
  const slot = fixtureSlot(root);
  executionCount = 0;
  await assert.rejects(
    initializeHostedTaskOnSlot(slot, gateway, {
      binding: 'static',
      template: selected,
      task: {
        taskDir: worker,
        flow: 'dev',
        platform: 'cli',
        task: { title: 'Partial task', sourceKind: 'text' },
        handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'original' },
      },
    }),
    /TASK_INIT_PARTIAL/,
  );
  // The three loaded-node samples reached 265.096s; allow twice that sample p95.
  assert.ok((executedOptions?.timeout ?? 0) >= 2 * 265_096);
  assert.ok((executedOptions?.timeout ?? Infinity) <= 10 * 60_000);
  assert.equal(executedOptions?.noRetry, true);
  assert.equal(executionCount, 1, 'a refused partial initialization must not be retried');
  assert.deepEqual(
    files.map((file) => fs.readFileSync(path.join(worker, file), 'utf8')),
    before,
  );
  assert.equal(
    fs.readdirSync(worker).some((file) => file.startsWith('.task-init-')),
    false,
  );
});

test('transport forwards node pool and captured pack roots through the installed CLI', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-node-command-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixtureFarm = path.join(root, 'node');
  const support = path.join(root, 'support');
  fs.mkdirSync(path.join(support, 'scripts/lib'), { recursive: true });
  fs.copyFileSync(
    new URL('../../../../scripts/lib/resolve-farmslot-cli.sh', import.meta.url),
    path.join(support, 'scripts/lib/resolve-farmslot-cli.sh'),
  );
  const cli = path.join(root, 'installed-cli');
  fs.writeFileSync(
    cli,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),root:process.env.FARMSLOT_ROOT??null,pool:process.env.FARMSLOT_POOL_DIR,projects:process.env.FARMSLOT_PROJECTS_DIR}));\n`,
    { mode: 0o755 },
  );
  const slot = {
    ...fixtureSlot(root),
    host: 'remote.invalid',
    machine: 'remote-node',
    sshTarget: 'remote.invalid',
  };
  const command = await hostedTaskCommand(slot, ['internal', 'slot-vars', 'fixture-1']);
  assert.match(
    command,
    /~\/farmslot-node/,
    'the existing content-addressed remapper must see the support reference',
  );
  const selected = remapRemoteFarmRefs(command, support, ['scripts', 'projects/fixture']);
  const env: NodeJS.ProcessEnv = { ...process.env, FARMSLOT_CLI: cli };
  delete env.FARMSLOT_ROOT;
  delete env.FARMSLOT_POOL_DIR;
  delete env.FARMSLOT_PROJECTS_DIR;
  const output = execFileSync('/bin/bash', ['-c', selected], {
    env,
    cwd: root,
    encoding: 'utf8',
    timeout: 4000,
  });
  assert.deepEqual(JSON.parse(output), {
    args: ['--json', 'internal', 'slot-vars', 'fixture-1'],
    root: null,
    pool: path.join(fixtureFarm, 'pool'),
    projects: path.join(support, 'projects'),
  });
});
