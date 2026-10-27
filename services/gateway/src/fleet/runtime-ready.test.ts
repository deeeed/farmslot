import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { ActiveResourcePointer, ResourceStatus, Run, SlotResource } from '@farmslot/protocol';

let row: Record<string, unknown>;
let run: Pick<Run, 'id' | 'status' | 'slotId'>;
let resources: SlotResource[];
let states: Record<string, ResourceStatus[]>;
let active: ActiveResourcePointer | undefined;
let liveProcess = false;
let controlOk = true;
let refusal: string | undefined;
let afterProbe: (() => void) | undefined;
const calls: string[] = [];
const realConfig = await import('../core/config.js');
let prepareSeconds: number | undefined;
let compileSeconds: number | undefined;
const bootTimeouts: number[] = [];
mock.module('../methods/slot/prepare-command.js', {
  namedExports: { PREPARE_PREFLIGHT_TIMEOUT_MS: 900_000 },
});
mock.module('../core/state.js', { namedExports: { readSlotRow: async () => ({ ...row }) } });
mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => ({ projectName: 'proof', resourceVars: {} }),
    loadProjectVars: async () => ({
      projectJson: {
        timeouts: { prepare_preflight_s: prepareSeconds, build_compile_s: compileSeconds },
      },
    }),
  },
});
mock.module('../runs/store.js', { namedExports: { getRun: () => run } });
mock.module('../sources/runtime.js', {
  namedExports: { withSlotSources: async (_id: string, body: () => Promise<void>) => body() },
});
mock.module('../methods/runtime-capabilities.js', {
  namedExports: {
    getRuntimeCapabilityRegistry: () => ({
      withSlotResourceShutdown: async (
        _slot: string,
        _run: string,
        _resource: string,
        device: boolean,
        body: () => Promise<void>,
      ) => {
        assert.equal(device, true);
        if (refusal) return { ok: false, reason: refusal };
        await body();
        return { ok: true };
      },
    }),
  },
});
mock.module('./resource-process.js', {
  namedExports: { probeResourceProcess: async () => (liveProcess ? { pid: 123 } : undefined) },
});
mock.module('./resource-manager.js', {
  namedExports: {
    resolveSlotResources: async () => resources,
    getActiveResource: () => active,
    probeResourceStatus: async (_slot: string, id: string) => {
      calls.push('probe:' + id);
      const values = states[id];
      const status = values.length > 1 ? values.shift() : values[0];
      afterProbe?.();
      return { status, detail: 'test observation' };
    },
    executeResourceControl: async (
      slot: string,
      id: string,
      action: string,
      extras: unknown,
      owner: string,
      options: { bootTimeoutMs: number },
    ) => {
      assert.deepEqual([slot, action, extras, owner], ['slot', 'boot', undefined, 'run']);
      calls.push('boot:' + id);
      bootTimeouts.push(options.bootTimeoutMs);
      return { ok: controlOk, detail: 'test boot' };
    },
  },
});
const { ensureRunRuntimeReady } = await import('./runtime-ready.js');
function resource(id: string, type: SlotResource['definition']['type']): SlotResource {
  return {
    id,
    status: 'unknown',
    definition: {
      type,
      label: id,
      streamable: false,
      controllable: true,
      hooks: { health: 'probe', boot: 'launch' },
    },
  };
}
beforeEach(() => {
  prepareSeconds = undefined;
  compileSeconds = undefined;
  bootTimeouts.length = 0;
  row = { current_run_id: 'run', slot_epoch: 1 };
  run = { id: 'run', slotId: 'slot', status: 'dispatching' };
  resources = [resource('browser', 'browser'), resource('server', 'dev-server')];
  states = { browser: ['stopped', 'running'], server: ['stopped', 'running'] };
  active = undefined;
  liveProcess = false;
  controlOk = true;
  refusal = undefined;
  afterProbe = undefined;
  calls.length = 0;
});
const ready = (
  gate: () => Promise<void> = async () => {
    calls.push('pressure');
  },
) => ensureRunRuntimeReady('slot', 'run', gate);

test('cold runtime boots server then browser and rechecks each with explicit run ownership', async () => {
  await ready();
  assert.deepEqual(calls, [
    'probe:server',
    'pressure',
    'boot:server',
    'probe:server',
    'probe:browser',
    'pressure',
    'boot:browser',
    'probe:browser',
  ]);
});
test('healthy runtime and foreign healthy processes are reused without a boot', async () => {
  states = { browser: ['running'], server: ['running'] };
  active = { pid: 123, startedAt: '', runId: 'operator' };
  liveProcess = true;
  await ready();
  assert.deepEqual(calls, ['probe:server', 'probe:browser']);
});
test('missing-hook and attached resources retain existing policy', async () => {
  resources[0].definition.hooks = { health: 'probe' };
  resources[1].definition.controllable = false;
  await ready();
  assert.deepEqual(calls, []);
});
for (const status of ['unknown', 'error', 'stale'] as const)
  test(`${status} runtime refuses without boot`, async () => {
    states.server = [status];
    await assert.rejects(ready(), new RegExp(status));
    assert.deepEqual(calls, ['probe:server']);
  });
test('failed boot and unhealthy post-boot both refuse later resources', async () => {
  controlOk = false;
  await assert.rejects(ready(), /failed to boot/);
  assert.ok(!calls.includes('probe:browser'));
  controlOk = true;
  states.server = ['stopped'];
  await assert.rejects(ready(), /stopped after boot/);
});
test('changed owner, epoch and cancellation during health cannot authorize a boot', async () => {
  for (const change of [
    () => {
      row.current_run_id = 'successor';
    },
    () => {
      row.slot_epoch = 2;
    },
    () => {
      run.status = 'cancelled';
    },
  ]) {
    row = { current_run_id: 'run', slot_epoch: 1 };
    run.status = 'dispatching';
    calls.length = 0;
    afterProbe = change;
    await assert.rejects(ready(), /ownership changed/);
    assert.deepEqual(calls, ['probe:server']);
  }
});
test('pressure refusal and foreign device/runtime ownership stop boot', async () => {
  await assert.rejects(
    ready(async () => {
      throw new Error('pressure refused');
    }),
    /pressure refused/,
  );
  refusal = 'foreign device lease';
  await assert.rejects(ready(), /foreign device lease/);
  states.server = ['stopped'];
  refusal = undefined;
  active = { pid: 123, startedAt: '', runId: 'foreign' };
  liveProcess = true;
  await assert.rejects(ready(), /foreign live process/);
  assert.ok(!calls.some((call) => call.startsWith('boot:')));
});
test('cleanup, handoff and recovery fences refuse before health', async () => {
  for (const field of ['cleanup_run_id', 'handoff_run_id', 'workspace_recovery']) {
    row = { current_run_id: 'run', slot_epoch: 1, [field]: 'foreign' };
    await assert.rejects(ready(), /ownership changed/);
  }
  assert.deepEqual(calls, []);
});

test('undeclared launch budget uses normal prepare budget, allowing a cold Terminal boot', async () => {
  await ready();
  assert.deepEqual(bootTimeouts, [900_000, 900_000]);
});
for (const field of ['prepare', 'compile'])
  test(`only fresh boot receives its declared ${field} launch budget`, async () => {
    if (field === 'prepare') prepareSeconds = 3600;
    else compileSeconds = 600;
    await ready();
    assert.deepEqual(bootTimeouts, [
      field === 'prepare' ? 3_600_000 : 600_000,
      field === 'prepare' ? 3_600_000 : 600_000,
    ]);
  });
