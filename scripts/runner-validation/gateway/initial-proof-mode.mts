// Manual proof: real private registry leases and provider hooks, without workers or active slots.
import '../lib/no-inherited-git-location.mjs';

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type {
  RunCreateResult,
  RunGetResult,
  RuntimeCapabilityProofMode,
  RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';

interface InitialProofObservation {
  runId: string;
  mode: RuntimeCapabilityProofMode;
  leaseId: string;
  noPriorPlan: boolean;
  markerObserved: boolean;
}

const source = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'initial-proof-mode-'));
const checkout = path.join(scratch, 'checkout');
const tmuxDir = fs.mkdtempSync('/tmp/fs-proof-tmux-');
process.env.TMUX_TMPDIR = tmuxDir;
delete process.env.TMUX;
const project = path.join(scratch, 'projects', 'proof-project');
fs.mkdirSync(checkout, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(scratch, 'pool'));
for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
  const target = path.join(scratch, marker);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(source, marker), target);
}
Object.assign(process.env, {
  FARMSLOT_ROOT: scratch,
  FARMSLOT_PROJECTS_DIR: path.join(scratch, 'projects'),
  FARMSLOT_POOL_DIR: path.join(scratch, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(scratch, '.runs'),
});
const templateRoot = path.join(project, 'proof-templates', 'dev');
fs.mkdirSync(templateRoot, { recursive: true });
const providers = Object.fromEntries(
  ['client', 'sim'].map((id) => [
    id,
    {
      label: id,
      version: '1',
      share_policy: 'exclusive',
      ...(id === 'client' ? { dependencies: ['sim'] } : {}),
      cost: { class: 'low', resources: [] },
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actions: Object.fromEntries(
        ['acquire', 'health', 'release'].map((action) => [
          action,
          { kind: 'slot-action', action_id: `${id}-${action}` },
        ]),
      ),
      affected_resources: [],
      release_effects: ['Remove the owned marker'],
    },
  ]),
);
const actions = Object.fromEntries(
  ['client', 'sim'].flatMap((id) => [
    [`${id}-acquire`, { label: `Acquire ${id}`, command: `printf acquired > .owned-${id}` }],
    [
      `${id}-health`,
      {
        label: `Observe ${id}`,
        command: `test -f .owned-${id} && printf '${id}\\n' >> .health-observations`,
      },
    ],
    [`${id}-release`, { label: `Release ${id}`, command: `rm -f .owned-${id}` }],
  ]),
);
fs.writeFileSync(
  path.join(project, 'project.json'),
  JSON.stringify({
    name: 'proof-project',
    slot_actions: actions,
    runtime_capabilities: { providers },
    execution_templates: {
      sources: [{ id: 'proof', kind: 'workspace', root: { projectPath: 'proof-templates' } }],
      defaults: [
        {
          when: { flow: 'dev', platform: 'cli', runMode: 'interactive' },
          templateId: 'dev/authored',
        },
        {
          when: { flow: 'dev', platform: 'cli', runMode: 'autonomous' },
          templateId: 'dev/ids-only',
        },
      ],
    },
  }),
);
function template(id: string, mode?: RuntimeCapabilityProofMode): string {
  const requirements = ['client', 'sim'].map((capabilityId) => ({
    capabilityId,
    mode,
    reason: 'Observe owned provider acquisition',
  }));
  return `---\nid: dev/${id}\ntitle: Initial proof requirements\ndescription: Observe private provider acquisition.\nflow: dev\nplatforms: [cli]\nruntime_capabilities: [client, sim]\n${mode ? `runtime_capability_requirements: '${JSON.stringify(requirements)}'\n` : ''}---\n\n# Private proof\n\n- [ ] Observe acquired resources.\n`;
}
fs.writeFileSync(path.join(templateRoot, 'ids-only.md'), template('ids-only'));
fs.writeFileSync(
  path.join(scratch, 'pool', 'proof-machine.json'),
  JSON.stringify({
    machine: 'proof-machine',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    os: process.platform,
    slots: [
      {
        id: 'proof-slot',
        session: 'proof-session',
        project: 'proof-project',
        platform: 'cli',
        repo: checkout,
      },
    ],
  }),
);
const { createRun, persistRunNow } = await import('../../../services/gateway/src/runs/store.js');
const { prepareConfiguredRunCapabilities } =
  await import('../../../services/gateway/src/run-engine/declared-capabilities.js');
const { runtimeCapabilityAcquire, runtimeCapabilityStatus, runtimeCapabilityRelease } =
  await import('../../../services/gateway/src/methods/runtime-capabilities.js');
async function owner(mode: 'interactive' | 'autonomous') {
  const run = createRun({
    project: 'proof-project',
    flowType: 'dev',
    mode,
    ticketOrPr: 'Initial proof requirement validation',
    slotId: 'proof-slot',
    transport: 'tmux',
  });
  await persistRunNow(run);
  return run;
}
async function release(runId: string) {
  const released = await runtimeCapabilityRelease({
    slotId: 'proof-slot',
    ownerRunId: runId,
    keepWarm: false,
  });
  assert.equal(released.ok, true, JSON.stringify(released));
  for (const id of ['client', 'sim'])
    assert.equal(fs.existsSync(path.join(checkout, `.owned-${id}`)), false);
}
const missing = await owner('autonomous');
await assert.rejects(prepareConfiguredRunCapabilities(missing.id), /proof.mode|authored/);
assert.equal(fs.existsSync(path.join(checkout, '.health-observations')), false);
await release(missing.id);
const observations: InitialProofObservation[] = [];
for (const mode of ['state', 'visual', 'mixed'] as const) {
  fs.writeFileSync(path.join(templateRoot, 'authored.md'), template('authored', mode));
  const run = await owner('interactive');
  try {
    assert.equal(
      (await runtimeCapabilityStatus({ slotId: 'proof-slot' })).proofPlans[run.id],
      undefined,
    );
    await prepareConfiguredRunCapabilities(run.id);
    const after = await runtimeCapabilityStatus({ slotId: 'proof-slot' });
    assert.deepEqual(
      after.proofPlans[run.id]!.requirements.map((item) => item.capabilityId).sort(),
      ['client', 'sim'],
    );
    for (const id of ['client', 'sim']) {
      assert.equal(fs.readFileSync(path.join(checkout, `.owned-${id}`), 'utf8'), 'acquired');
      assert.ok(fs.readFileSync(path.join(checkout, '.health-observations'), 'utf8').includes(id));
      assert.equal(
        after.proofPlans[run.id]!.requirements.find((item) => item.capabilityId === id)?.mode,
        mode,
      );
    }
    const lease = after.leases.find(
      (item) =>
        item.owner.runId === run.id && item.capabilityId === 'client' && item.state === 'acquired',
    );
    assert.ok(lease);
    observations.push({
      runId: run.id,
      mode,
      leaseId: lease.id,
      noPriorPlan: true,
      markerObserved: true,
    });
  } finally {
    await release(run.id);
  }
}
const warm = await owner('autonomous');
try {
  for (const capabilityId of ['client', 'sim']) {
    const acquired = await runtimeCapabilityAcquire({
      slotId: 'proof-slot',
      ownerRunId: warm.id,
      capabilityId,
      proofRequirement: { capabilityId, mode: 'state', reason: 'Explicit retained proof input' },
    });
    assert.equal(acquired.ok, true);
  }
  const before = (await runtimeCapabilityStatus({ slotId: 'proof-slot' })).proofPlans[warm.id];
  await prepareConfiguredRunCapabilities(warm.id);
  assert.deepEqual(
    (await runtimeCapabilityStatus({ slotId: 'proof-slot' })).proofPlans[warm.id],
    before,
  );
} finally {
  await release(warm.id);
}

async function gatewayDispatchProof() {
  const root = path.join(scratch, 'gateway-proof');
  const repo = path.join(root, 'checkout');
  fs.mkdirSync(repo, { recursive: true });
  for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
    const target = path.join(root, marker);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, marker), target);
  }
  fs.cpSync(path.join(scratch, 'projects'), path.join(root, 'projects'), { recursive: true });
  fs.cpSync(path.join(scratch, 'pool'), path.join(root, 'pool'), { recursive: true });
  const poolFile = path.join(root, 'pool', 'proof-machine.json');
  const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
  pool.slots[0].repo = repo;
  fs.writeFileSync(poolFile, JSON.stringify(pool));
  const configFile = path.join(root, 'projects', 'proof-project', 'project.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.paths = { runtime_dir: '.agent', artifact_dir: '.task' };
  config.defaults = { feature: { runner: 'scripted' } };
  config.scripted = { commands: { proof: { command: 'true' } } };
  for (const [id, action] of Object.entries(config.slot_actions)) {
    assert.ok(action && typeof action === 'object');
    Object.assign(action, {
      command: `node provider-hook.mjs ${id.replace('-', ' ')}`,
      refresh: ['none'],
    });
  }
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.writeFileSync(
    path.join(root, 'projects', 'proof-project', 'proof-templates', 'dev', 'authored.md'),
    template('authored', 'state'),
  );
  fs.writeFileSync(
    path.join(repo, 'provider-hook.mjs'),
    `
import fs from 'node:fs';
const [id, action] = process.argv.slice(2);
if (action === 'acquire') fs.writeFileSync('.owned-' + id, 'acquired');
else if (action === 'release') fs.rmSync('.owned-' + id, { force: true });
else {
  if (!fs.existsSync('.owned-' + id)) process.exit(1);
  fs.appendFileSync('.health-observations', id + '\\n');
  const count = fs.readFileSync('.health-observations', 'utf8').split('\\n').filter(x => x === 'sim').length;
  if (id === 'sim' && count >= 2) {
    fs.writeFileSync('.health-ready', 'observed');
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync('.continue')) {
      if (Date.now() > deadline) throw new Error('Health observation barrier timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
`,
  );
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'test: initialize private acquisition proof',
    ],
    { stdio: 'ignore' },
  );
  fs.writeFileSync(
    path.join(root, '.farm-status.json'),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      slots: [
        {
          slot: 'proof-slot',
          machine: 'proof-machine',
          project: 'proof-project',
          platform: 'cli',
          repo,
          session: 'proof-session',
          lifecycle: 'ready',
          phase: 'idle',
          enabled: true,
          agent: 'idle',
          health: { ssh: 'OK' },
        },
      ],
    }),
  );
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const home = path.join(root, 'home');
  testGatewayIdentity(home, `ws://127.0.0.1:${port}`);
  const env = {
    ...process.env,
    FARMSLOT_ROOT: root,
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_BACKLOG_DIR: path.join(root, '.backlog'),
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_PROFILE: 'proof',
    FARMSLOT_RPC_TIMEOUT_MS: '30000',
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '0',
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_DEMO_POOL: '0',
    TMUX_TMPDIR: tmuxDir,
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
  };
  const log = fs.openSync(path.join(root, 'gateway.log'), 'w');
  const gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: source,
    env,
    stdio: ['ignore', log, log],
  });
  const execute = promisify(execFile);
  async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const result = await execute(
      process.execPath,
      [
        path.join(source, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: source, env, timeout: 45_000, maxBuffer: 10_000_000 },
    );
    return JSON.parse(result.stdout);
  }
  async function poll<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (accepts(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Private gateway proof timed out; inspect ${root}/gateway.log`);
  }
  const owners: string[] = [];
  try {
    await poll(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch (error) {
          if (!(error instanceof TypeError) || gateway.exitCode !== null) throw error;
          return false;
        }
      },
      (value) => value,
    );
    const before = await rpc<RuntimeCapabilityStatusResult>('runtime.capability.status', {
      slotId: 'proof-slot',
    });
    assert.equal(before.leases.length, 0);
    const { run } = await rpc<RunCreateResult>('run.create', {
      project: 'proof-project',
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'Initial resource proof RPC',
      slotId: 'proof-slot',
      skipPrepare: true,
      runner: 'scripted',
      transport: 'tmux',
      scripted: { mode: 'command', commandRef: 'proof' },
      executionTemplateId: 'dev/authored',
    });
    owners.push(run.id);
    assert.equal(before.proofPlans[run.id], undefined);
    const atHealth = await poll(
      async () => ({
        ready: fs.existsSync(path.join(repo, '.health-ready')),
        run: (await rpc<RunGetResult>('run.get', { runId: run.id })).run,
      }),
      (value) => value.ready || ['blocked', 'failed'].includes(value.run.status),
    );
    fs.writeFileSync(path.join(root, 'dispatch-at-health.json'), JSON.stringify(atHealth, null, 2));
    assert.equal(atHealth.ready, true);
    assert.equal(atHealth.run.steps.find((step) => step.name === 'dispatch')?.status, 'running');
    assert.equal(atHealth.run.steps.find((step) => step.name === 'monitor')?.status, 'pending');
    for (const context of atHealth.run.agentContexts ?? []) {
      assert.equal(context.target, null);
      assert.equal(context.runnerSessionId, null);
      assert.equal(context.nativeSession, undefined);
    }
    const cancellation = rpc('run.cancel', {
      runId: run.id,
      reason: 'Private proof stops before worker delivery',
    });
    await poll(
      async () => (await rpc<RunGetResult>('run.get', { runId: run.id })).run.status,
      (value) => value === 'cancelled',
    );
    fs.writeFileSync(path.join(repo, '.continue'), 'continue');
    await cancellation;
    const after = await rpc<RuntimeCapabilityStatusResult>('runtime.capability.status', {
      slotId: 'proof-slot',
      ownerRunId: run.id,
    });
    assert.deepEqual(
      after.proofPlans[run.id]!.requirements.map((item) => item.capabilityId).sort(),
      ['client', 'sim'],
    );
    assert.equal(after.leases.filter((lease) => lease.state !== 'released').length, 0);
    assert.equal(fs.existsSync(path.join(repo, '.owned-client')), false);
    assert.equal(fs.existsSync(path.join(repo, '.owned-sim')), false);
    return {
      root,
      runId: run.id,
      noPriorPlanOrLease: true,
      healthBeforeWorkerDelivery: true,
      cleanup: 'cancelled and released',
    };
  } finally {
    try {
      for (const runId of owners) {
        const current = (await rpc<RunGetResult>('run.get', { runId })).run;
        if (['cancelled', 'failed', 'done'].includes(current.status)) {
          fs.writeFileSync(path.join(repo, '.continue'), 'continue');
          continue;
        }
        const cancellation = rpc('run.cancel', { runId, reason: 'Private proof teardown' });
        await poll(
          async () => (await rpc<RunGetResult>('run.get', { runId })).run.status,
          (value) => value === 'cancelled',
        );
        fs.writeFileSync(path.join(repo, '.continue'), 'continue');
        await cancellation;
      }
    } finally {
      const exited = once(gateway, 'exit');
      gateway.kill('SIGTERM');
      const timer = setTimeout(() => gateway.kill('SIGKILL'), 5_000);
      try {
        if (gateway.exitCode === null) await exited;
      } finally {
        clearTimeout(timer);
        fs.closeSync(log);
      }
    }
  }
}
const gateway = await gatewayDispatchProof();
assert.equal(fs.existsSync(path.join(tmuxDir, `tmux-${process.getuid?.()}/default`)), false);
console.log(
  'INITIAL_PROOF_MODE_PASS ' +
    JSON.stringify({
      scratch,
      observations,
      gateway,
      idsOnlyRefusedBeforeEffects: true,
      idsOnlyStoredPlanReused: true,
      cleanup: 'All provider resources released; isolated records retained',
    }),
);
