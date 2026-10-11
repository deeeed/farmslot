import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import type {
  Run,
  RuntimeCapabilityAcquireResult,
  RuntimeCapabilityReleaseResult,
} from '@farmslot/protocol';

// This explicit import selects the existing CI module-mock lane and forbids PTY
// operations before the fixture loads gateway modules.
await import('../runtime/mock-pty.test-support.js');
const f = await import('./run-recovery-fixture.js');

after(f.close);
const budget = { timeout: 5000 };

async function processFixture(t: TestContext) {
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},20)'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
  });
  await once(child, 'message');
  assert.ok(child.pid);
  return child;
}

test(
  'R1 published-branch recovery preserves local and remote worker commits',
  budget,
  async (t) => {
    const head = f.git(f.repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      f.rpc('slot.prepare', {
        slotId: f.slotId,
        branch: f.branch,
        forceNewBranch: true,
        flowType: 'dev',
        prepareProfile: 'git-only',
      }),
      /unique commits|refused to replace published branch/,
    );
    assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(f.git(f.origin, 'rev-parse', `refs/heads/${f.branch}`), head);

    const current = f.run(t, 'paused');
    f.updateRun(current.id, {
      recoveryAttempts: [
        {
          id: 'replay',
          attempt: 1,
          stepName: 'prepare',
          startedAt: new Date().toISOString(),
          status: 'started',
          triggeredBy: 'operator',
        },
      ],
      engineState: { prepareBranch: { slotId: f.slotId, branch: f.branch, started: true } },
    });
    const { executePrepareStep } = await import('./dispatch-lifecycle-steps.js');
    const monitors = new Map();
    const result = await executePrepareStep(current.id, {
      activeMonitors: monitors,
      broadcastFn: () => {},
      getRunFlags: () => undefined,
      normalizeEvalReplayForTaskWrite: async (_id, run) => run,
      stepPartialIO: new Map(),
    });
    assert.equal(result.outputs?.success, true);
    assert.equal(monitors.size, 0);
    assert.equal(f.git(f.repo, 'rev-parse', `refs/heads/${f.branch}`), head);
    assert.equal(f.git(f.origin, 'rev-parse', `refs/heads/${f.branch}`), head);
    const { run } = await f.rpc<{ run: Run }>('run.get', { runId: current.id });
    assert.equal(run.engineState?.prepareBranch?.branch, f.branch);
    f.updateRun(current.id, { status: 'done' });
  },
);

test(
  'R2 release refuses a live owner without changing process, slot or branch',
  budget,
  async (t) => {
    const child = await processFixture(t);
    const current = f.run(t);
    f.setSlot(current.id);
    const before = await f.readSlotRow(f.slotId);
    const head = f.git(f.repo, 'rev-parse', 'HEAD');
    f.commands.length = 0;
    await assert.rejects(
      f.rpc('slot.release', { slotId: f.slotId, keepWork: true }),
      /non-terminal run/,
    );
    assert.equal(process.kill(child.pid!, 0), true);
    assert.deepEqual(await f.readSlotRow(f.slotId), before);
    assert.equal(f.getRun(current.id)?.slotId, f.slotId);
    assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(
      f.commands.some((command) => /kill-window|kill-session|git reset/.test(command)),
      false,
    );
    f.updateRun(current.id, { status: 'done' });
    f.setSlot();
  },
);

test('R3 an exited runner cannot receive task text through its bare shell', budget, async (t) => {
  const child = await processFixture(t);
  f.setPanePid(child.pid!);
  const { execRunnerInput } = await import('../runners/registry.js');
  const vars = await f.loadSlotVars(f.slotId);
  const marker = path.join(f.root, 'prompt-was-executed');
  let mutationBuilt = false;
  await assert.rejects(
    execRunnerInput(vars, `${f.slotId}:dev`, 'claude', () => {
      mutationBuilt = true;
      return `touch '${marker}'`;
    }),
    /shell without a live foreground|no live foreground/,
  );
  assert.equal(mutationBuilt, false, 'the payload was never built or executed');
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
});

test(
  'R4 stale sandbox identity refuses reuse and restarts with isolated credentials',
  budget,
  async (t) => {
    const checkout = path.join(f.root, 'sandbox');
    const framework = new URL('../../../../', import.meta.url).pathname;
    const launcher = 'projects/farmslot-farm/setup/sandbox-dev.sh';
    for (const relative of [
      'scripts/dev.sh',
      'scripts/lib/stack-credentials.sh',
      'scripts/lib/sandbox-home.cjs',
      launcher,
      'projects/farmslot-farm/setup/sandbox-common.sh',
    ]) {
      mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
      copyFileSync(path.join(framework, relative), path.join(checkout, relative));
    }
    mkdirSync(path.join(checkout, 'apps/command-center'), { recursive: true });
    const runtime = path.join(checkout, 'runtime');
    mkdirSync(runtime);
    writeFileSync(path.join(runtime, 'isolated-home'), path.join(f.root, 'obsolete-home'));
    writeFileSync(path.join(checkout, '.env.ports'), 'GATEWAY_PORT=0\nVITE_PORT=0\n');
    const bin = path.join(checkout, 'bin');
    mkdirSync(bin);
    const capture = path.join(checkout, 'child.json');
    writeFileSync(
      path.join(bin, 'yarn'),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({node:process.env.FARMSLOT_NODE_TOKEN??null,gateway:process.env.FARMSLOT_GATEWAY_TOKEN??null,password:process.env.FARMSLOT_GATEWAY_PASSWORD??null,home:process.env.FARMSLOT_HOME}));setInterval(()=>{},20);\n`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      path.join(bin, 'curl'),
      `#!/usr/bin/env node\nif(process.env.RECOVERY_STALE_HEALTH==='1')process.exit(0);const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(path.join(runtime, 'sandbox-dev.pid'))}))process.exit(1);const end=Date.now()+500;function poll(){if(fs.existsSync(${JSON.stringify(capture)}))process.exit(0);if(Date.now()>=end)process.exit(1);setTimeout(poll,10);}poll();\n`,
      { mode: 0o755 },
    );
    const command = `cd '${checkout}' && PATH='${bin}':"$PATH" FARMSLOT_RUNTIME_DIR='${runtime}' FARMSLOT_SLOT_REPO='${checkout}' FARMSLOT_NODE_TOKEN=stale-node FARMSLOT_GATEWAY_TOKEN=stale-gateway FARMSLOT_GATEWAY_PASSWORD=stale-password`;
    f.configureProject({
      slot_actions: {
        'sandbox-health': {
          label: 'Sandbox health',
          command: `${command} RECOVERY_STALE_HEALTH=1 bash '${launcher}' health --gateway-port 0`,
          refresh: ['none'],
        },
        'sandbox-start': {
          label: 'Sandbox start',
          command: `${command} bash '${launcher}' start --gateway-port 0`,
          refresh: ['none'],
        },
      },
    });
    t.after(async () => {
      const pidfile = path.join(runtime, 'sandbox-dev.pid');
      if (!existsSync(pidfile)) {
        f.configureProject();
        return;
      }
      const pid = Number(readFileSync(pidfile, 'utf8'));
      process.kill(pid, 'SIGTERM');
      const { probeResourceProcess } = await import('../fleet/resource-process.js');
      const vars = await f.loadSlotVars(f.slotId);
      const end = Date.now() + 1000;
      while (await probeResourceProcess(vars, pid)) {
        assert.ok(Date.now() < end, 'sandbox process closed');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      f.configureProject();
    });
    const refused = await f.rpc<{ ok: boolean; detail?: string }>('slot.action.run', {
      slotId: f.slotId,
      actionId: 'slot:sandbox-health',
    });
    assert.equal(refused.ok, false);
    assert.match(refused.detail ?? '', /isolated home/);
    const prepared = await f.rpc<{ ok: boolean }>('slot.action.run', {
      slotId: f.slotId,
      actionId: 'slot:sandbox-start',
    });
    assert.equal(prepared.ok, true);
    const child = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual([child.node, child.gateway, child.password], [null, null, null]);
    assert.equal(child.home, realpathSync(path.join(runtime, 'home')));
    assert.equal(readFileSync(path.join(runtime, 'isolated-home'), 'utf8').trim(), child.home);
  },
);

test(
  'R5 branch selection detaches an idle holder and protects active/dirty work',
  budget,
  async (t) => {
    const { inspectReleasableBranchHolders, releaseBranchHolderForSelection } =
      await import('../methods/dispatch/branch-checkout.js');
    const { loadFleetStatus } = await import('../fleet/state.js');
    const head = f.git(f.repo, 'rev-parse', 'HEAD');
    f.setSlot();
    const fleet = await loadFleetStatus();
    const eligible = await inspectReleasableBranchHolders(fleet.slots, f.project, f.branch, [
      'recovery-requested',
    ]);
    assert.ok(eligible.has(f.slotId));
    assert.equal(
      f.git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
      f.branch,
      'preview is read-only',
    );
    await releaseBranchHolderForSelection('recovery-requested', f.branch);
    assert.equal(f.git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
    assert.equal(f.git(f.repo, 'rev-parse', `refs/heads/${f.branch}`), head);
    f.git(f.repo, 'checkout', f.branch);
    const active = f.run(t);
    f.setSlot(active.id);
    await assert.rejects(
      releaseBranchHolderForSelection('recovery-requested', f.branch),
      /Branch.*held/,
    );
    assert.equal(f.git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), f.branch);
    f.updateRun(active.id, { status: 'done' });
    writeFileSync(path.join(f.repo, 'worker.txt'), 'uncommitted work\n');
    f.setSlot();
    await assert.rejects(
      releaseBranchHolderForSelection('recovery-requested', f.branch),
      /Branch.*held|tracked/,
    );
    assert.equal(readFileSync(path.join(f.repo, 'worker.txt'), 'utf8'), 'uncommitted work\n');
    f.git(f.repo, 'checkout', '--', 'worker.txt');
  },
);

test('R6 orphan cleanup keeps the lease until the owned process stops', budget, async (t) => {
  const child = await processFixture(t);
  const foreign = await processFixture(t);
  const current = f.run(t);
  f.setSlot(current.id);
  const pidfile = path.join(f.repo, '.agent/runtime.pid');
  const correctStop = path.join(f.repo, '.agent/correct-stop');
  mkdirSync(path.dirname(pidfile), { recursive: true });
  const stop = `if test -f '${correctStop}'; then kill "$(cat '${pidfile}')"; fi; rm -f '${pidfile}'`;
  f.configureProject({
    resources: {
      runtime: {
        type: 'dev-server',
        label: 'Runtime',
        watch: { type: 'pid-file', path: pidfile },
        hooks: {
          boot: `printf '%s' '${child.pid}' > '${pidfile}'`,
          health: `test -f '${pidfile}' && kill -0 "$(cat '${pidfile}')"`,
          shutdown: stop,
        },
      },
    },
    runtime_capabilities: {
      providers: {
        runtime: {
          label: 'Runtime',
          version: '1',
          share_policy: 'exclusive',
          cost: { class: 'low', resources: [] },
          actions: {
            acquire: { kind: 'resource', resource_id: 'runtime', action: 'boot' },
            health: { kind: 'resource', resource_id: 'runtime', action: 'health' },
            release: { kind: 'resource', resource_id: 'runtime', action: 'shutdown' },
          },
          release_effects: ['stop owned runtime'],
        },
      },
    },
  });
  t.after(() => f.configureProject());
  const params = { slotId: f.slotId, ownerRunId: current.id, capabilityId: 'runtime' };
  const acquired = await f.rpc<RuntimeCapabilityAcquireResult>('runtime.capability.acquire', {
    ...params,
    proofRequirement: { capabilityId: 'runtime', reason: 'recovery', mode: 'state' },
  });
  assert.equal(acquired.ok, true);
  const refused = await f.rpc<RuntimeCapabilityReleaseResult>('runtime.capability.release', {
    ...params,
    keepWarm: false,
  });
  assert.equal(
    refused.ok,
    false,
    'a hook that drops its pidfile without stopping its process must fail',
  );
  assert.match(
    refused.failures.map((failure) => failure.reason).join(' '),
    /process survives|cleanup deferred/,
  );
  assert.equal(process.kill(child.pid!, 0), true);
  assert.equal(process.kill(foreign.pid!, 0), true);
  writeFileSync(pidfile, String(foreign.pid));
  const foreignRefusal = await f.rpc<RuntimeCapabilityReleaseResult>('runtime.capability.release', {
    ...params,
    keepWarm: false,
  });
  assert.equal(foreignRefusal.ok, false);
  assert.match(
    foreignRefusal.failures.map((failure) => failure.reason).join(' '),
    /ownership changed/,
  );
  assert.equal(process.kill(foreign.pid!, 0), true);
  writeFileSync(pidfile, String(child.pid));
  writeFileSync(correctStop, 'stop the owned runtime');
  const recovered = await f.rpc<RuntimeCapabilityReleaseResult>('runtime.capability.release', {
    ...params,
    keepWarm: false,
  });
  assert.equal(recovered.ok, true);
  assert.notEqual(child.signalCode, null);
  assert.equal(process.kill(foreign.pid!, 0), true);
});
