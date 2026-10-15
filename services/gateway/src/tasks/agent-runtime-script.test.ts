import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { farmslotRoot, type ProjectVars, type SlotVars } from '../core/config.js';
import { expandTemplateWithReservedLast } from '../core/hooks.js';
import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';

import {
  agentRuntimeCommandsForSlot,
  agentRuntimeScriptForSlot,
  farmslotDirectoryForSlot,
} from './agent-runtime-script.js';
import { markCommandForSlot } from './checklist-target.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'active-node-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = [path.join(root, 'production'), path.join(root, 'development')];
  for (const deployment of roots) {
    const runtime = path.join(deployment, 'node_modules/@farmslot/agent-runtime');
    await mkdir(runtime, { recursive: true });
    await symlink(
      path.join(farmslotRoot, 'packages/protocol'),
      path.join(deployment, 'node_modules/@farmslot/protocol'),
      'dir',
    );
    await cp(
      new URL('../../../../packages/agent-runtime/scripts', import.meta.url),
      path.join(runtime, 'scripts'),
      { recursive: true },
    );
    await cp(
      new URL('../../../../packages/agent-runtime/bin', import.meta.url),
      path.join(runtime, 'bin'),
      { recursive: true },
    );
    await writeFile(
      path.join(runtime, 'package.json'),
      JSON.stringify({
        name: '@farmslot/agent-runtime',
        exports: { './scripts/*': './scripts/*' },
      }),
    );
  }
  let active = roots[1];
  const requests: Array<{ cwd?: string; argv: string[] }> = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const request = JSON.parse(raw);
      requests.push(request.params);
      const [command, ...argv] = request.params.argv;
      const result = spawnSync(command, argv, {
        cwd: request.params.cwd ?? active,
        encoding: 'utf8',
      });
      handleNodeResponse(request.id, true, {
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
  } as unknown as WebSocket;
  const vars: SlotVars = {
    slotId: 'fixture-1',
    host: 'remote.invalid',
    machine: 'runtime-fixture',
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
    sshTarget: 'remote.invalid',
    projectName: 'fixture',
    resourceVars: {},
  };
  registerNode(vars.machine, 1, ws);
  t.after(() => unregisterByWs(ws));
  return {
    root,
    roots,
    vars,
    requests,
    ws,
    activate: (index: number) => {
      active = roots[index];
    },
  };
}

test('remote helpers follow the connected deployment and never resolve in the product checkout', async (t) => {
  const { roots, vars, requests, activate } = await fixture(t);
  for (const index of [1, 0]) {
    activate(index);
    for (const helper of [
      'mark-checklist-step.cjs',
      'check-task-artifact-contract.mjs',
      'acceptance-ledger.cjs',
    ]) {
      assert.equal(
        await agentRuntimeScriptForSlot(vars, helper),
        path.join(roots[index], 'node_modules/@farmslot/agent-runtime/scripts', helper),
      );
    }
  }
  assert.ok(requests.every((request) => request.cwd === undefined));
});

test('worker commands execute the connected acceptance helper with an explicit task directory', async (t) => {
  const { root, roots, vars, requests } = await fixture(t);
  const taskDir = path.join(root, 'task with spaces');
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({
      task: { acceptanceCriteria: ['The configured helper reads this task'] },
    }),
  );
  const { AC_CMD: command, ARTIFACT_CHECK_CMD: artifactCheck } =
    await agentRuntimeCommandsForSlot(vars);
  assert.ok(command.includes(roots[1]));
  assert.ok(artifactCheck.includes(roots[1]));
  assert.equal(requests.length, 1);
  const result = spawnSync('bash', ['-c', `${command} list --task-dir "$1"`, '_', taskDir], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /The configured helper reads this task/);
  assert.ok(requests.every((request) => request.cwd === undefined));
});

test('the selected remote mark engine executes the frozen CI command and writes a receipt', async (t) => {
  const { root, roots, vars } = await fixture(t);
  const repo = path.join(root, 'product');
  const taskDir = path.join(repo, '.task/proof');
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  await writeFile(path.join(repo, 'app.js'), 'export const app = 1;\n');
  await writeFile(
    path.join(taskDir, 'CHECKLIST.md'),
    '- [ ] CI parity [DETERMINISTIC: ci.local_check]\n',
  );
  await writeFile(
    path.join(taskDir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify({
      deterministicChecks: [
        {
          checklist: 'CHECKLIST.md',
          stepNumber: 1,
          reference: 'ci.local_check',
          command: 'printf "real local check\\n"',
        },
      ],
    }),
  );
  const command = await markCommandForSlot(vars);
  assert.ok(command.includes(roots[1]));
  const result = spawnSync('bash', ['-c', `${command} "$1" 1`, '_', taskDir], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(
    await readFile(
      path.join(taskDir, 'artifacts/deterministic-checks/CHECKLIST.md/1.json'),
      'utf8',
    ),
  );
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.exitCode, 0);
  assert.match(await readFile(path.join(taskDir, receipt.logPath), 'utf8'), /real local check/);
  assert.match(await readFile(path.join(taskDir, 'CHECKLIST.md'), 'utf8'), /\[x\]/);
});

test('unavailable helper exports fail closed instead of falling back to production', async (t) => {
  const { roots, vars } = await fixture(t);
  await rm(
    path.join(roots[1], 'node_modules/@farmslot/agent-runtime/scripts/mark-checklist-step.cjs'),
  );
  await assert.rejects(
    agentRuntimeScriptForSlot(vars, 'mark-checklist-step.cjs'),
    /connected node runtime-fixture cannot resolve/,
  );
});

test('local helpers and project harness marker overrides preserve their selection', async () => {
  const vars = { host: 'localhost', machine: 'local', resourceVars: {} } as SlotVars;
  assert.equal(
    await agentRuntimeScriptForSlot(vars, 'acceptance-ledger.cjs'),
    path.join(farmslotRoot, 'packages/agent-runtime/scripts/acceptance-ledger.cjs'),
  );
  const project = {
    projectJson: { vars: { mark_cmd: 'harness checklist mark' } },
  } as unknown as ProjectVars;
  assert.equal(
    await markCommandForSlot({ ...vars, host: 'unconnected.invalid' }, project),
    'harness checklist mark',
  );
});

test('configured marker resolves its nested harness command in the connected installation', async (t) => {
  const { roots, vars, requests, activate } = await fixture(t);
  const localCi = { enabled: true, local_check: 'printf parity' };
  const project: ProjectVars = {
    projectName: 'demo',
    projectConfig: '/pack/project.json',
    projectFixturesDir: '/pack/fixtures',
    projectTemplatesDir: '/pack/templates',
    projectJson: {
      name: 'demo',
      ci: localCi,
      vars: {
        mark_cmd: '"$({{resolver}})" checklist mark',
        resolver: 'node "{{farmslot_dir}}/resolve.mjs" "{{FARMSLOT_DIR}}"',
      },
    },
    runtimeDir: '.agent',
    artifactDir: '.task',
  };
  for (const index of [1, 0]) {
    activate(index);
    const harness = path.join(roots[index], 'harness with spaces');
    await writeFile(harness, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(harness, 0o700);
    await writeFile(
      path.join(roots[index], 'resolve.mjs'),
      `process.stdout.write(process.argv[2] + '/harness with spaces');\n`,
    );
    assert.equal(await farmslotDirectoryForSlot(vars), roots[index]);
    assert.equal(
      expandTemplateWithReservedLast(
        '{{resolver}} {{feedback}}',
        vars,
        project,
        { feedback: 'literal {{repo}}' },
        { farmslot_dir: roots[index] },
      ),
      `node "${roots[index]}/resolve.mjs" "${roots[index]}" literal {{repo}}`,
    );
    const ciTemplate = expandTemplateWithReservedLast(
      '{{resolver}}\n{{CI_PARITY_STEP}}\n{{feedback}}',
      vars,
      project,
      { feedback: 'literal {{repo}}' },
      { farmslot_dir: roots[index] },
    );
    assert.ok(ciTemplate.includes(`node "${roots[index]}/resolve.mjs"`));
    assert.ok(ciTemplate.includes('[DETERMINISTIC: ci.local_check]'));
    assert.ok(ciTemplate.includes('literal {{repo}}'));
    const command = await markCommandForSlot(vars, project);
    assert.ok(command.includes(roots[index]));
    assert.ok(!command.includes('~/farmslot-node'));
    const result = spawnSync('bash', ['-c', `${command} --checklist REVIEW.md 2`], {
      cwd: roots[index],
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'checklist',
      'mark',
      '--checklist',
      'REVIEW.md',
      '2',
    ]);
  }
  assert.ok(requests.every((request) => request.cwd === undefined));
});

test('framework directory resolution refuses failed or relative results instead of guessing a deployment', async (t) => {
  const { vars, ws } = await fixture(t);
  for (const response of [
    { exitCode: 1, stdout: '' },
    { exitCode: 0, stdout: 'relative-root' },
  ]) {
    ws.send = (raw) => {
      handleNodeResponse(JSON.parse(String(raw)).id, true, { ...response, stderr: '' });
    };
    await assert.rejects(
      farmslotDirectoryForSlot(vars),
      /cannot resolve its Farmslot installation directory/,
    );
  }
  assert.equal(
    await farmslotDirectoryForSlot({ host: 'localhost', machine: 'local' }),
    farmslotRoot,
  );
});
