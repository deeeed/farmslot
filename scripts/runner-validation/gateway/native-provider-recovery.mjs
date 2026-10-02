import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const acquire = (rpc, fixture) =>
  rpc('runtime.capability.acquire', {
    slotId: fixture.slotId,
    capabilityId: 'owned-server',
    ownerRunId: fixture.runId,
    proofRequirement: {
      capabilityId: 'owned-server',
      reason: 'Provider ownership recovery proof',
      mode: 'state',
    },
  });

export async function proveProviderRecovery({
  fixtures,
  rpc,
  restartGateway,
  capabilityFile,
  readStatus,
  wait,
  check,
  executable,
  configFile,
}) {
  for (const fixture of fixtures.filter((item) =>
    ['legacy-provider', 'restarted-provider', 'child-provider', 'metadata-provider'].includes(
      item.fault,
    ),
  )) {
    const pidFile = path.join(fixture.repo, 'owned-server.pid');
    if (fixture.fault === 'metadata-provider') mkdirSync(`${pidFile}.meta`);
    const result = acquire(rpc, fixture);
    const pid = Number(readFileSync(`${pidFile}.created`, 'utf8'));
    if (fixture.fault === 'metadata-provider') {
      assert.equal(result.ok, false, 'Ownership metadata failure must reject acquisition');
      assert.match(JSON.stringify(result), /ownership metadata failed/);
      await wait(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            if (error.code === 'ESRCH') return false;
            throw error;
          }
        },
        (v) => !v,
        'metadata failure rollback stops its newly started provider',
      );
      check('metadata failure retains process identity for exact rollback');
      continue;
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    if (fixture.fault === 'child-provider') {
      assert.ok(
        result.lease.providerProcesses.some((frame) => frame.pid === pid),
        'Child lease must own its actual provider',
      );
      assert.equal(
        JSON.parse(readFileSync(`${pidFile}.meta`, 'utf8')).runId,
        fixture.runId,
        'Boot sidecar must record the lease owner',
      );
      assert.notEqual(
        readStatus().slots.find((slot) => slot.slot === fixture.slotId).current_run_id,
        fixture.runId,
      );
      assert.equal(
        rpc('runtime.capability.release', {
          slotId: fixture.slotId,
          ownerRunId: fixture.runId,
          keepWarm: false,
        }).ok,
        true,
      );
      check('child provider ownership follows the lease while the slot still names its parent');
      continue;
    }
    if (fixture.fault === 'legacy-provider') {
      await restartGateway(() => {
        const store = JSON.parse(readFileSync(capabilityFile, 'utf8'));
        for (const lease of store.leases)
          if (lease.slotId === fixture.slotId) delete lease.providerProcesses;
        writeFileSync(capabilityFile, JSON.stringify(store));
        const meta = JSON.parse(readFileSync(`${pidFile}.meta`, 'utf8'));
        delete meta.process;
        writeFileSync(`${pidFile}.meta`, JSON.stringify(meta));
      });
    } else {
      assert.equal(
        rpc('resource.control', {
          slotId: fixture.slotId,
          resourceId: 'owned-server',
          action: 'shutdown',
        }).ok,
        true,
      );
      execFileSync(process.execPath, [executable, '--server-boot', pidFile], {
        cwd: fixture.repo,
        env: { ...process.env, NATIVE_COHERENCE_CONFIG: configFile },
      });
    }
    const completed = rpc('run.forceComplete', { runId: fixture.runId });
    assert.ok(
      completed.run.slotTeardownSkipped,
      'Legacy or restarted provider must defer automatic cleanup',
    );
    const slot = readStatus().slots.find((row) => row.slot === fixture.slotId);
    assert.equal(slot.lifecycle, 'held');
    assert.equal(slot.phase, 'occupied');
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
    const refused = rpc('runtime.capability.stopWarm', {
      slotId: fixture.slotId,
      capabilityId: 'owned-server',
    });
    assert.equal(
      refused.outcome,
      'failed',
      'Unknown provider ownership must refuse automatic shutdown',
    );
    assert.equal(
      rpc('resource.control', {
        slotId: fixture.slotId,
        resourceId: 'owned-server',
        action: 'shutdown',
      }).ok,
      true,
    );
    const stopped = rpc('runtime.capability.stopWarm', {
      slotId: fixture.slotId,
      capabilityId: 'owned-server',
    });
    assert.equal(
      stopped.outcome,
      'stopped',
      `Verified explicit shutdown must clear retained ownership: ${JSON.stringify(stopped)}`,
    );
    const settled = rpc('runtime.capability.status', { slotId: fixture.slotId }).leases.find(
      (lease) => lease.capabilityId === 'owned-server',
    );
    assert.equal(
      settled.state,
      'released',
      'Successful operator cleanup must settle the lease state',
    );
    assert.equal(
      settled.cleanupFailure,
      undefined,
      'Successful operator cleanup must clear its prior failure',
    );
    assert.equal(settled.providerCleanupDeferred, undefined);
    assert.equal(
      rpc('slot.release', { slotId: fixture.slotId, keepWork: true, keepWarm: false }).released,
      true,
    );
    const ready = readStatus().slots.find((row) => row.slot === fixture.slotId);
    assert.equal(ready.lifecycle, 'ready');
    assert.ok(!ready.held_reason);
    check(
      `${fixture.fault} recovers through explicit resource shutdown, capability settlement and work-preserving release`,
    );
  }
}
