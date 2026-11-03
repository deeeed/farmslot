// Opt-in setup proof. All Gateway, node, SSH, Git and run state is disposable; no live target.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, cp, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePackPortability } from '../../../packages/protocol/src/node/pack-portability.js';
import { cleanupOnExit, poll, startReaper, writeJson } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

import { CANARY_PROJECT } from './fixtures.mjs';
import { canaryShape, driveRun, judgeLifecycle } from './run-driver.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(process.argv[2] ?? 'temp/canary-setup-proof');
await mkdir(evidence, { recursive: true });
const log = async (event: string, detail?: Record<string, unknown>) => {
  await appendFile(path.join(evidence, 'proof.jsonl'), JSON.stringify({ event, ...detail }) + '\n');
  console.log(event);
};
const reaper = startReaper();
let stopStack: (() => Promise<string[]>) | undefined;
let result: Record<string, unknown> | undefined;
const cleanupErrors: string[] = [];
const cleanup = cleanupOnExit(async () => {
  cleanupErrors.push(...((await stopStack?.()) ?? []));
  if (!cleanupErrors.length) reaper.done();
  await writeJson(path.join(evidence, 'result.json'), {
    ...result,
    status: result?.status === 'pass' && !cleanupErrors.length ? 'pass' : 'fail',
    cleanupErrors,
  });
});

try {
  const machine = 'canary-setup-node';
  const slot = `${CANARY_PROJECT}-setup-1`;
  const stack = await startRemoteNodeStack({
    root,
    evidence,
    machine,
    slots: ['setup-bootstrap-1'],
    projects: () => [{ name: 'setup-bootstrap', projectJson: {}, files: {} }],
    seeds: { 'setup-bootstrap': { 'README.md': 'Isolated setup bootstrap.\n' } },
    cliSnapshots: path.join(evidence, '..', 'cli-snapshots'),
    ...(process.env.FARMSLOT_CANARY_SETUP_CLI_SNAPSHOT
      ? { cliSnapshot: process.env.FARMSLOT_CANARY_SETUP_CLI_SNAPSHOT }
      : {}),
    ownerTag: 'canary-setup-proof',
    reaper,
    onCleanup: (stop) => {
      stopStack = stop;
    },
    log,
  });
  const fixture = stack.fixture;
  const nodeInstall = path.join(fixture, 'node-user-home/farmslot-node-dev');
  const nodeProjects = path.join(nodeInstall, 'projects');
  await mkdir(nodeInstall, { recursive: true });
  await mkdir(nodeProjects);
  for (const entry of ['scripts', 'packages', 'services', 'node_modules'])
    await symlink(path.join(root, entry), path.join(nodeInstall, entry));
  // The node owns a separate pool and project tree, as a deployed node does.
  await symlink(path.join(fixture, 'node-pool'), path.join(nodeInstall, 'pool'));
  const bootstrapPool = path.join(fixture, 'pool/setup-bootstrap.json');
  const original = JSON.parse(await readFile(bootstrapPool, 'utf8'));
  await writeJson(bootstrapPool, {
    ...original,
    env: {
      FARMSLOT_WORKSPACE: nodeInstall,
      FARMSLOT_POOL_DIR: path.join(nodeInstall, 'pool'),
      FARMSLOT_PROJECTS_DIR: nodeProjects,
    },
  });
  const config = path.join(fixture, 'setup-config.json');
  await writeJson(config, { live: { nodes: [{ machine, slot }] } });
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(root, 'scripts/runner-validation/canary/setup.mts'),
      '--farm',
      fixture,
      '--config',
      config,
      '--apply',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}`,
        TSX_TSCONFIG_PATH: path.join(root, 'services/gateway/tsconfig.json'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  );
  const project = path.join(fixture, 'projects', CANARY_PROJECT);
  assert.deepEqual(validatePackPortability(project), []);
  const projectJson = JSON.parse(await readFile(path.join(project, 'project.json'), 'utf8'));
  assert.equal(projectJson.repo_url, undefined);
  assert.equal(projectJson.hooks.post_merge_install, 'true');
  // Copy only what deploy-node.sh delivers. Never share the Gateway's project directory.
  const deployed = path.join(nodeProjects, CANARY_PROJECT);
  await mkdir(deployed);
  for (const file of ['project.json', 'templates'])
    await cp(path.join(project, file), path.join(deployed, file), { recursive: true });
  const pool = `canary-${machine}.json`;
  const generatedPool = JSON.parse(await readFile(path.join(fixture, 'pool', pool), 'utf8'));
  // The synthetic .invalid address is remote to the Gateway, local to this fixture's node.
  await writeJson(path.join(nodeInstall, 'pool', pool), { ...generatedPool, host: 'localhost' });
  assert.notEqual(await realpath(project), await realpath(deployed));
  await stack.call('fleet.refresh');
  await poll(
    'generated canary slot in isolated fleet',
    async () => {
      const { fleet } = await stack.call<{ fleet: { slots: { slot: string }[] } }>('fleet.status');
      return fleet.slots.some((row) => row.slot === slot) ? true : undefined;
    },
    30_000,
  );
  await log('setup applied and deployed into separate node roots');
  const driven = await driveRun({
    call: stack.call,
    log,
    label: 'isolated-generated-setup',
    dir: path.join(evidence, 'lifecycle'),
    slotId: slot,
    shape: canaryShape('isolated setup proof'),
    hooks: { pollMs: () => 500 },
  });
  const judged = judgeLifecycle('lifecycle', driven, {});
  assert.equal(judged.status, 'pass', JSON.stringify({ judged, error: driven.run.error }));
  const slotRepo = path.join(fixture, 'node-user-home/farmslot-canary/slot');
  assert.ok(existsSync(slotRepo));
  assert.equal(
    execFileSync('git', ['-C', slotRepo, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
    '',
  );
  const modelLog = path.join(stack.holds, 'model-calls.log');
  const modelCalls = existsSync(modelLog)
    ? readFileSync(modelLog, 'utf8').split('\n').filter(Boolean).length
    : 0;
  assert.equal(modelCalls, 0);
  result = {
    status: 'pass',
    target: 'isolated',
    liveRuns: 0,
    modelCalls,
    runId: driven.runId,
    outcome: driven.outcome,
    timingsS: driven.timingsS,
    projectRootsSeparate: true,
    workspaceSource: projectJson.execution_templates.sources[0],
    poolEnvironment: JSON.parse(readFileSync(path.join(fixture, 'pool', pool), 'utf8')).env,
  };
  await log('generated setup lifecycle passed', { runId: driven.runId });
} finally {
  await cleanup();
}
assert.deepEqual(cleanupErrors, []);
