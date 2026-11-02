import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { NativeSessionManager } from './manager.js';
import {
  nativeWorkerEnvironment,
  type NativeWorkerLaunch,
  nativeWorkerProjectToolsFirst,
} from './worker-launch.js';

test('a native worker starts with project tools ahead of its runner directory', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worker-path-')));
  const runnerDirectory = join(root, 'runner-bin');
  const asdf = join(root, 'asdf');
  const pathFile = join(root, 'worker-path');
  for (const directory of [runnerDirectory, join(asdf, 'shims')])
    mkdirSync(directory, { recursive: true });
  // The runner's directory holds a Node, as an asdf-installed claude's or cursor-agent's does.
  for (const directory of [runnerDirectory, join(asdf, 'shims')])
    writeFileSync(join(directory, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`, {
      mode: 0o755,
    });
  const runner = join(runnerDirectory, 'codex');
  writeFileSync(
    runner,
    `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
require('node:fs').writeFileSync(process.env.FIXTURE_PATH_FILE, process.env.PATH);
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'worker-path'}}});
});
`,
    { mode: 0o700 },
  );
  const manager = new NativeSessionManager(join(root, 'state'));
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: runner,
    safetyTier: 'full-auto',
    environment: {
      set: { ASDF_DATA_DIR: asdf, FIXTURE_PATH_FILE: pathFile, CODEX_HOME: join(root, 'account') },
      unset: [],
    },
  };
  const session = await manager.ensure(
    'owner',
    { sessionId: randomUUID(), runner: 'codex', cwd: root },
    launch,
  );
  t.after(async () => {
    await manager.closeWorker('owner', session.id, session.generation, launch.leaseId);
    rmSync(root, { recursive: true, force: true });
  });
  const path = readFileSync(pathFile, 'utf8').split(delimiter);
  assert.deepEqual(path.slice(0, 2), [join(asdf, 'shims'), runnerDirectory]);
});

test("a profile that moves HOME keeps the worker's asdf shims first and working", (t) => {
  const home = mkdtempSync(join(tmpdir(), 'worker-asdf-home-'));
  const profile = mkdtempSync(join(tmpdir(), 'worker-profile-home-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });
  mkdirSync(join(home, '.asdf', 'shims'), { recursive: true });
  const originalEnvironment = process.env;
  try {
    process.env = { HOME: home, PATH: '/usr/bin:/bin' };
    const worker = nativeWorkerEnvironment({
      leaseId: 'fixture-lease',
      safetyTier: 'sandboxed',
      environment: { set: {}, unset: [] },
    });
    assert.equal(worker.ASDF_DATA_DIR, join(home, '.asdf'));
    // A Cursor profile's HOME, then the runner's directory ahead of PATH, as the host applies them.
    const final = nativeWorkerProjectToolsFirst({
      ...worker,
      HOME: profile,
      PATH: ['/runner-bin', worker.PATH].join(delimiter),
    });
    assert.equal(final.PATH?.split(delimiter)[0], join(home, '.asdf', 'shims'));
  } finally {
    process.env = originalEnvironment;
  }
});

test("a worker resolves the project's Node ahead of the runner's own directory and the host's", (t) => {
  const home = mkdtempSync(join(tmpdir(), 'worker-node-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // A runner installed under another Node (mini's claude under asdf's nodejs 22) or bundling one
  // (cursor-agent), ahead of PATH as the host puts it, and Homebrew's node first on the host PATH.
  const shims = join(home, '.asdf', 'shims');
  const runnerDirectory = join(home, 'runner-bin');
  const brew = join(home, 'homebrew-bin');
  for (const directory of [shims, runnerDirectory, brew]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    chmodSync(join(directory, 'node'), 0o755);
  }
  const host = { HOME: home, PATH: [brew, '/usr/bin', '/bin'].join(delimiter) };
  const worker = nativeWorkerProjectToolsFirst({
    ...host,
    PATH: [runnerDirectory, shims, host.PATH].join(delimiter),
  });
  const node = (env: NodeJS.ProcessEnv) =>
    spawnSync('/bin/sh', ['-c', 'command -v node'], { env, encoding: 'utf8' }).stdout.trim();
  assert.equal(node(worker), join(shims, 'node'));
  assert.equal(worker.PATH?.split(delimiter).filter((entry) => entry === shims).length, 1);
});

test('worker environments remove inherited and configured control-plane credentials', () => {
  const originalEnvironment = process.env;
  const credentials = {
    FARMSLOT_NODE_TOKEN: 'synthetic-node-token',
    FARMSLOT_GATEWAY_TOKEN: 'synthetic-gateway-token',
    FARMSLOT_GATEWAY_PASSWORD: 'synthetic-gateway-password',
  };
  try {
    // Replace the environment rather than reading any real credential values.
    process.env = { ...credentials, CODEX_LB_API_KEY: 'synthetic-runner-key' };
    for (const set of [{}, credentials]) {
      const env = nativeWorkerEnvironment({
        leaseId: 'fixture-lease',
        safetyTier: 'sandboxed',
        environment: { set, unset: [] },
      });
      for (const name of Object.keys(credentials)) assert.equal(Object.hasOwn(env, name), false);
      assert.equal(env.CODEX_LB_API_KEY, 'synthetic-runner-key');
      assert.equal(env.DISABLE_OMC, '1');
      assert.equal(env.DISABLE_OMX, '1');
    }
    assert.deepEqual(credentials, {
      FARMSLOT_NODE_TOKEN: 'synthetic-node-token',
      FARMSLOT_GATEWAY_TOKEN: 'synthetic-gateway-token',
      FARMSLOT_GATEWAY_PASSWORD: 'synthetic-gateway-password',
    });
  } finally {
    process.env = originalEnvironment;
  }
});

test('filesystem launch contract rejects overlapping source grants and binds grants into its digest', async () => {
  const {
    decodeNativeWorkerLaunch,
    nativeWorkerLaunchDigest,
    validateNativeWorkerFilesystemPolicy,
  } = await import('./worker-launch.js');
  const launch = {
    leaseId: '10000000-0000-4000-8000-000000000001',
    safetyTier: 'sandboxed',
    environment: { set: {}, unset: [] },
    filesystemPolicy: { readOnlyRoots: ['/repo'], writableRoots: ['/task', '/output'] },
  };
  const decoded = decodeNativeWorkerLaunch(launch);
  assert.deepEqual(decoded.filesystemPolicy, launch.filesystemPolicy);
  assert.notEqual(
    nativeWorkerLaunchDigest(decoded),
    nativeWorkerLaunchDigest({ ...decoded, filesystemPolicy: undefined }),
  );
  assert.notEqual(
    nativeWorkerLaunchDigest(decoded),
    nativeWorkerLaunchDigest({
      ...decoded,
      filesystemPolicy: { ...launch.filesystemPolicy, writableRoots: ['/other'] },
    }),
  );
  for (const writableRoots of [['/'], ['/repo'], ['/repo/output'], ['/repo/../repo']]) {
    assert.throws(
      () => validateNativeWorkerFilesystemPolicy({ ...launch.filesystemPolicy, writableRoots }),
      /overlap/,
    );
  }
  for (const invalid of [
    {},
    { ...launch.filesystemPolicy, writableRoots: ['relative'] },
    { ...launch.filesystemPolicy, writableRoots: [] },
  ])
    assert.throws(() => validateNativeWorkerFilesystemPolicy(invalid), /absolute paths/);
});

test('launch digest ignores gateway routing but still guards launch settings', async () => {
  const { nativeWorkerLaunchDigest } = await import('./worker-launch.js');
  const launch = {
    leaseId: '10000000-0000-4000-8000-000000000001',
    safetyTier: 'sandboxed' as const,
    environment: { set: { PROJECT_FLAG: '1' }, unset: [] },
  };
  const withUrl = (GW_URL: string) => ({
    ...launch,
    environment: { ...launch.environment, set: { ...launch.environment.set, GW_URL } },
  });
  // A session saved before the node reported its URL, or reached through
  // another URL for the same gateway, still resumes.
  assert.equal(nativeWorkerLaunchDigest(withUrl('ws://gw:7801')), nativeWorkerLaunchDigest(launch));
  assert.equal(
    nativeWorkerLaunchDigest(withUrl('ws://gw:7801')),
    nativeWorkerLaunchDigest(withUrl('ws://10.0.0.5:7801')),
  );
  assert.notEqual(
    nativeWorkerLaunchDigest({
      ...withUrl('ws://gw:7801'),
      environment: { set: { PROJECT_FLAG: '2', GW_URL: 'ws://gw:7801' }, unset: [] },
    }),
    nativeWorkerLaunchDigest(withUrl('ws://gw:7801')),
  );
  assert.notEqual(
    nativeWorkerLaunchDigest({ ...launch, accountLabel: 'other' }),
    nativeWorkerLaunchDigest(launch),
  );
});

test('reviewer no-prompt policy is private and can resume without changing sandbox grants', async () => {
  const { decodeNativeWorkerLaunch, nativeWorkerLaunchDigest } = await import('./worker-launch.js');
  const launch = {
    leaseId: '10000000-0000-4000-8000-000000000001',
    safetyTier: 'sandboxed',
    environment: { set: {}, unset: [] },
  };
  const worker = decodeNativeWorkerLaunch(launch);
  const reviewer = decodeNativeWorkerLaunch({ ...launch, approvalPolicy: 'never' });
  assert.equal(worker.approvalPolicy, undefined);
  assert.equal(reviewer.approvalPolicy, 'never');
  assert.equal(reviewer.safetyTier, worker.safetyTier);
  assert.equal(nativeWorkerLaunchDigest(reviewer), nativeWorkerLaunchDigest(worker));
  for (const approvalPolicy of ['untrusted', 'on-request', true])
    assert.throws(() => decodeNativeWorkerLaunch({ ...launch, approvalPolicy }), /approval policy/);
});

test('an autonomous run turns model questions off without changing the launch digest', async () => {
  const { decodeNativeWorkerLaunch, nativeWorkerLaunchDigest } = await import('./worker-launch.js');
  const launch = {
    leaseId: '10000000-0000-4000-8000-000000000001',
    safetyTier: 'sandboxed',
    environment: { set: {}, unset: [] },
  };
  const interactive = decodeNativeWorkerLaunch(launch);
  const autonomous = decodeNativeWorkerLaunch({ ...launch, modelQuestions: 'off' });
  assert.equal(interactive.modelQuestions, undefined);
  assert.equal(Object.hasOwn(interactive, 'modelQuestions'), false);
  assert.equal(autonomous.modelQuestions, 'off');
  // A journal saved before the run's setting existed still resumes.
  assert.equal(nativeWorkerLaunchDigest(autonomous), nativeWorkerLaunchDigest(interactive));
  for (const modelQuestions of ['on', 'never', false, true])
    assert.throws(
      () => decodeNativeWorkerLaunch({ ...launch, modelQuestions }),
      /model questions setting/,
    );
});
