// Opt-in isolated RPC proof. Only disposable runtime processes are started.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FLOW_STEPS,
  isCompletionPrerequisiteFailure,
  Methods,
  type ResourceControlResult,
  type Run,
  type RuntimeCapabilityCatalogEntry,
} from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test(
  'terminal cleanup stops detached slot runtimes over RPC and preserves a live successor',
  { timeout: 90_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_TERMINAL_RUNTIME_LIVE, '1');
    const output = process.env.FARMSLOT_TERMINAL_RUNTIME_PROOF_OUT;
    assert.ok(output);
    const root = await mkdtemp('/tmp/terminal-runtime-');
    const project = 'terminal-runtime-proof';
    const resources = ['dev-server', 'metro', 'browser', 'console-tail', 'simulator'];
    const slots = ['done-slot', 'cancelled-slot', 'failed-slot', 'stacked-slot', 'refused-slot'];
    for (const dir of [
      'pool',
      'scripts',
      'services/gateway',
      `projects/${project}`,
      'bin',
      ...slots,
    ])
      await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable runtime proof\n');
    await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
    await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
    // No real tmux server or model is part of this proof.
    await writeFile(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
    const stop = path.join(root, 'stop.cjs');
    const health = path.join(root, 'health.cjs');
    await writeFile(
      stop,
      `const fs=require('fs');const p=Number(fs.readFileSync(process.argv[2],'utf8'));try{process.kill(p,'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e}const until=Date.now()+3000;function check(){try{process.kill(p,0)}catch(e){if(e.code==='ESRCH')return;throw e}if(Date.now()>until)process.exit(1);setTimeout(check,20)}check();`,
    );
    await writeFile(
      health,
      `const fs=require('fs');try{process.kill(Number(fs.readFileSync(process.argv[2],'utf8')),0)}catch(e){if(e.code==='ESRCH')process.exit(1);throw e}`,
    );
    await writeFile(
      path.join(root, 'projects', project, 'project.json'),
      JSON.stringify({
        name: project,
        hooks: {},
        resources: Object.fromEntries(
          resources.map((id) => [
            id,
            {
              type: id === 'simulator' ? 'device' : id === 'browser' ? 'browser' : 'dev-server',
              platform: id === 'simulator' ? 'ios' : undefined,
              controllable: true,
              hooks: {
                shutdown: `${process.execPath} '${stop}' '{{repo}}/${id}.pid'`,
                health: `${process.execPath} '${health}' '{{repo}}/${id}.pid'`,
              },
            },
          ]),
        ),
      }),
    );
    await writeFile(
      path.join(root, 'pool/fixture.json'),
      JSON.stringify({
        machine: hostname(),
        host: 'localhost',
        ssh_user: userInfo().username,
        os: process.platform,
        platform: 'cli',
        project,
        slots: slots.map((id) => ({
          id,
          enabled: true,
          mode: 'dispatch',
          repo: path.join(root, id),
          session: id,
          resources: Object.fromEntries(resources.map((resource) => [resource, {}])),
        })),
      }),
    );
    await writeFile(
      path.join(root, '.farm-status.json'),
      JSON.stringify({
        slots: slots.map((slot) => ({
          slot,
          machine: hostname(),
          project,
          platform: 'cli',
          lifecycle: 'busy',
          phase: 'working',
          slot_epoch: 1,
        })),
      }),
    );
    const fixture = await createNativeProofFixture(t, root);
    const { createRun, getRun, updateRun } = await import('../runs/store.js');
    const { loadSlotVars, readSlotRow, updateSlotStatus } = await import('../core/index.js');
    const { nodeSupportRetentionReferences } = await import('../node-support/activation.js');
    const { startRun, initRunEngine, cleanupSlotAfterRunFailure } =
      await import('../run-engine/orchestrator.js');
    initRunEngine(() => {});
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
        throw error;
      }
    };
    const ownedPids: number[] = [];
    t.after(() => {
      for (const pid of ownedPids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    const rows = [];
    for (const [index, slotId] of slots.entries()) {
      const repo = path.join(root, slotId);
      const pids = resources.map(() =>
        Number(
          execFileSync(
            process.execPath,
            [
              '-e',
              `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,cwd:${JSON.stringify(repo)},stdio:'ignore'});console.log(c.pid);c.unref()`,
            ],
            { encoding: 'utf8' },
          ).trim(),
        ),
      );
      ownedPids.push(...pids);
      for (const [i, resource] of resources.entries())
        await writeFile(path.join(repo, `${resource}.pid`), String(pids[i]));
      const run = createRun({
        project,
        flowType: 'dev',
        mode: 'interactive',
        ticketOrPr: `FIXTURE-${index}`,
        slotId,
        runner: 'scripted',
        model: 'fixture',
      });
      await updateSlotStatus(slotId, {
        current_run_id: run.id,
        lifecycle: 'busy',
        phase: 'working',
        slot_epoch: 1,
      });
      if (slotId === 'refused-slot') {
        const gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        };
        execFileSync('git', ['init', '-q', '-b', 'fixture'], { cwd: repo });
        execFileSync(
          'git',
          ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'test: fixture'],
          { cwd: repo, env: gitEnv },
        );
        execFileSync('git', ['branch', 'main'], { cwd: repo });
        execFileSync('git', ['remote', 'add', 'origin', repo], { cwd: repo });
        execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repo });
        const task = path.join(root, 'tasks', run.id, 'TASK.md');
        await mkdir(path.dirname(task), { recursive: true });
        await writeFile(task, '# Refused completion fixture\n');
        updateRun(run.id, {
          mode: 'autonomous',
          status: 'completing',
          branch: 'fixture',
          taskFile: task,
          recordedEvidenceContractVersion: 1,
          steps: FLOW_STEPS.dev.map((name, at) => ({
            name,
            status: at < FLOW_STEPS.dev.indexOf('complete') ? 'done' : 'pending',
          })),
        });
        await startRun(run.id);
        const refused = await fixture.client.call<{ run: Run }>(Methods.RUN_GET, { runId: run.id });
        assert.equal(refused.run.status, 'failed');
        assert.match(refused.run.error ?? '', /Artifact mirror refresh failed/);
        assert.ok(isCompletionPrerequisiteFailure(refused.run));
        assert.ok(pids.every(alive), 'recoverable completion retains its owned runtime');
        assert.equal((await readSlotRow(slotId))?.current_run_id, run.id);
        const references = await nodeSupportRetentionReferences(await loadSlotVars(slotId));
        assert.ok(references.activeRuns?.some((owner) => owner.runId === run.id));
        assert.ok(!references.endedRunIds?.includes(run.id));
        // The fixture explicitly stops its unleased runtimes before discarding the checkout.
        for (const resourceId of resources) {
          const stopped: ResourceControlResult = await fixture.client.call<ResourceControlResult>(
            Methods.RESOURCE_CONTROL,
            {
              slotId,
              resourceId,
              action: 'shutdown',
            },
          );
          assert.equal(stopped.ok, true);
        }
        await fixture.client.call(Methods.SLOT_RELEASE, {
          slotId,
          expectedRunId: run.id,
          forceReset: true,
        });
      } else if (slotId === 'done-slot') {
        updateRun(run.id, {
          status: 'ci-watching',
          steps: FLOW_STEPS.dev.map((name) => ({ name, status: 'done' })),
        });
        await startRun(run.id);
      } else if (slotId === 'failed-slot') {
        updateRun(run.id, { status: 'failed' });
        await cleanupSlotAfterRunFailure(slotId, run.id, 'isolated runtime proof');
      } else if (slotId === 'cancelled-slot') {
        updateRun(run.id, { status: 'monitoring' });
        await fixture.client.call(Methods.RUN_CANCEL, { runId: run.id });
      } else {
        const child = createRun({
          project,
          flowType: 'dev',
          mode: 'interactive',
          ticketOrPr: 'FIXTURE-CHILD',
          slotId,
          runner: 'scripted',
          model: 'fixture',
          parentRunId: run.id,
        });
        updateRun(child.id, {
          status: 'monitoring',
          steps: [{ name: 'find-slot', status: 'done' }],
        });
        await updateSlotStatus(slotId, { current_run_id: child.id, slot_epoch: 2 });
        updateRun(run.id, {
          status: 'ci-watching',
          steps: FLOW_STEPS.dev.map((name) => ({ name, status: 'done' })),
        });
        await startRun(run.id);
        assert.ok(pids.every(alive), 'the live child keeps its runtimes');
        assert.equal((await readSlotRow(slotId))?.current_run_id, child.id);
        await fixture.client.call(Methods.RUN_CANCEL, { runId: child.id });
      }
      const observed = await fixture.client.call<{ run: { status: string } }>(Methods.RUN_GET, {
        runId: run.id,
      });
      assert.equal(observed.run.status, getRun(run.id)?.status);
      assert.ok(
        pids.every((pid) => !alive(pid)),
        `${slotId} runtimes stopped`,
      );
      if (slotId === 'cancelled-slot')
        assert.equal((await readSlotRow(slotId))?.current_run_id, run.id);
      rows.push({
        slotId,
        status: observed.run.status,
        processesStopped: pids.length,
        childPreservedUntilItsCancel: slotId === 'stacked-slot',
        retainedUntilExplicitDiscard: slotId === 'refused-slot',
      });
    }
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, 'receipt.json'),
      JSON.stringify(
        { status: 'PASS', rows, productOperations: [], realModelOrTmuxStarted: false },
        null,
        2,
      ),
    );
  },
);

test(
  'terminal shutdown protects a device retargeted from another slot',
  { timeout: 30_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_TERMINAL_RUNTIME_LIVE, '1');
    const { RuntimeCapabilityRegistry } = await import('../runtime-capabilities/registry.js');
    const { RuntimeCapabilityStore } = await import('../runtime-capabilities/store.js');
    const directory = await mkdtemp('/tmp/terminal-device-guard-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const SLOT = 'finished-slot';
    const { assertDeviceTargetAvailable } = await import('../methods/runtime-capabilities.js');
    const device = {
      id: 'device',
      project: 'fixture',
      label: 'device',
      version: '1',
      dependencies: [],
      sharePolicy: 'exclusive',
      actions: {
        acquire: { kind: 'slot-action', actionId: 'device.acquire' },
        health: { kind: 'slot-action', actionId: 'device.health' },
        release: { kind: 'slot-action', actionId: 'device.release' },
      },
      releaseEffects: [],
      provenance: { project: 'fixture', providerId: 'device', version: '1', digest: 'fixture' },
      availability: { state: 'available' },
      parameters: { type: 'object', properties: { simulator: { type: 'string' } } },
      cost: { class: 'low', resources: [{ id: 'simulator', kind: 'device', access: 'exclusive' }] },
    } satisfies RuntimeCapabilityCatalogEntry;
    const registry = new RuntimeCapabilityRegistry({
      store: new RuntimeCapabilityStore(path.join(directory, 'leases.json')),
      catalogForSlot: async (slotId) => ({ slotId, project: 'fixture', capabilities: [device] }),
      runAction: async () => ({ ok: true }),
      assertTargetAvailable: (input) =>
        assertDeviceTargetAvailable(input, {
          loadSlotVars: async (slotId) => ({
            machine: 'fixture-host',
            resourceVars: { simulator: slotId === SLOT ? 'SIM-A' : 'SIM-B' },
          }),
          catalogForSlot: async () => ({ capabilities: [device] }),
        }),
    });
    assert.equal(
      (
        await registry.acquire({
          slotId: 'other-slot',
          capabilityId: 'device',
          ownerRunId: 'live-child',
          parameters: { simulator: 'SIM-A' },
          proofRequirement: { capabilityId: 'device', reason: 'validation', mode: 'state' },
        })
      ).ok,
      true,
    );
    let stopped = false;
    const result = await registry.withSlotResourceShutdown(
      SLOT,
      'finished-run',
      'ios-sim',
      true,
      async () => {
        stopped = true;
      },
    );
    assert.equal(result.ok, false);
    assert.equal(stopped, false);
    if (!result.ok) assert.match(result.reason, /SIM-A/);
    assert.equal(
      (
        await registry.withSlotResourceShutdown(
          SLOT,
          'finished-run',
          'metro',
          false,
          async () => 'stopped',
        )
      ).ok,
      true,
    );
  },
);
