import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
    [
      'legacy-provider',
      'restarted-provider',
      'child-provider',
      'metadata-provider',
      'capture-provider',
      'cycle-provider',
      'compact-provider',
    ].includes(item.fault),
  )) {
    const pidFile = path.join(fixture.repo, 'owned-server.pid');
    if (fixture.fault === 'metadata-provider') mkdirSync(`${pidFile}.meta`);
    let result;
    try {
      result = acquire(rpc, fixture);
    } catch (error) {
      if (fixture.fault !== 'capture-provider') throw error;
      assert.match(String(error), /Fixture identity capture failed/);
      result = { ok: false };
    }
    const pid = Number(readFileSync(`${pidFile}.created`, 'utf8'));
    if (fixture.fault === 'capture-provider') {
      assert.equal(result.ok, false);
      assert.ok(
        rpc('runtime.capability.status', { slotId: fixture.slotId }).leases.every(
          (lease) => lease.state !== 'acquiring',
        ),
        'Capture failure must settle acquisition',
      );
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
        'capture failure exact rollback',
      );
      check(
        'post-boot identity capture failure settles acquisition and rolls back its owned process',
      );
      continue;
    }
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
    if (fixture.fault === 'cycle-provider') {
      assert.equal(
        rpc('runtime.capability.release', {
          slotId: fixture.slotId,
          ownerRunId: fixture.runId,
          keepWarm: false,
        }).ok,
        true,
      );
      assert.equal(acquire(rpc, fixture).ok, true);
      rpc('runtime.capability.release', {
        slotId: fixture.slotId,
        ownerRunId: fixture.runId,
        keepWarm: true,
      });
      const currentPid = Number(readFileSync(pidFile, 'utf8'));
      assert.equal(
        rpc('runtime.capability.stopWarm', { slotId: fixture.slotId, capabilityId: 'owned-server' })
          .outcome,
        'stopped',
        'Warm sweep must select the current provider instance',
      );
      await wait(
        () => {
          try {
            process.kill(currentPid, 0);
            return true;
          } catch (error) {
            if (error.code === 'ESRCH') return false;
            throw error;
          }
        },
        (v) => !v,
        'current provider stopped',
      );
      check('cold restart followed by warm cleanup uses the current kernel identity');
      continue;
    }
    if (fixture.fault === 'compact-provider') {
      rpc('runtime.capability.acquire', {
        slotId: fixture.slotId,
        capabilityId: 'app',
        ownerRunId: fixture.runId,
        proofRequirement: {
          capabilityId: 'app',
          reason: 'Dependency retention proof',
          mode: 'state',
        },
      });
      const session = `coherence-churn-${randomUUID()}`;
      fixture.session = session;
      execFileSync('tmux', ['new-session', '-d', '-s', session, '-c', fixture.repo, 'sleep 600']);
      rpc('run.forceComplete', { runId: fixture.runId });
      const retained = rpc('runtime.capability.status', { slotId: fixture.slotId }).leases;
      const ids = retained.map((lease) => lease.id);
      await restartGateway(() => {
        const store = JSON.parse(readFileSync(capabilityFile, 'utf8'));
        for (let index = 0; index < 1050; index++)
          store.leases.push({
            ...retained[0],
            id: `terminal-churn-${index}`,
            owner: { runId: `churn-${index}` },
            state: 'released',
            keepWarmUntil: undefined,
            providerCleanupDeferred: undefined,
            providerProcesses: undefined,
            dependencyLeaseIds: [],
            updatedAt: new Date(Date.now() + index).toISOString(),
          });
        writeFileSync(capabilityFile, JSON.stringify(store));
      });
      rpc('runtime.capability.release', { slotId: fixture.slotId, ownerRunId: 'churn-noop' });
      const compacted = rpc('runtime.capability.status', { slotId: fixture.slotId }).leases;
      for (const id of ids)
        assert.ok(
          compacted.some((lease) => lease.id === id),
          'Deferred provider and dependency records must survive compaction',
        );
      process.kill(pid, 0);
      check('terminal history churn retains live deferred provider ownership and dependencies');
      continue;
    }
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
