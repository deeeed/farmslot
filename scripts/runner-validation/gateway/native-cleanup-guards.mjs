import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function prepareCleanupGuards({ temporary, project, gitInit }) {
  const fixtures = [];
  for (const [index, runner] of ['cursor', 'scripted', 'claude'].entries()) {
    const repo = path.join(temporary, `guard-${index}`);
    gitInit(repo);
    const executable = path.join(repo, runner === 'cursor' ? 'agent' : 'program.cjs');
    writeFileSync(executable, 'setInterval(()=>{},1000);\n');
    const session = `coherence-guard-${randomUUID()}`;
    const [paneId, panePid] = execFileSync(
      'tmux',
      [
        'new-session',
        '-d',
        '-P',
        '-F',
        '#{pane_id}\t#{pane_pid}',
        '-s',
        session,
        '-c',
        repo,
        `exec ${quote(process.execPath)} ${quote(executable)}`,
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\t');
    assert.ok(paneId && panePid, 'Fixture must record its exact created pane');
    const slotId = `coherence-guard-slot-${randomUUID()}`;
    const runId = randomUUID();
    const now = new Date().toISOString();
    fixtures.push({
      session,
      repo,
      paneId,
      panePid,
      runner,
      slotId,
      runId,
      slot: {
        id: slotId,
        project,
        platform: 'cli',
        repo,
        session,
        enabled: true,
        mode: 'dispatch',
      },
      status: { slot: slotId, lifecycle: 'busy', phase: 'working', current_run_id: runId },
      run: {
        id: runId,
        project,
        ticketOrPr: 'COHERENCE-GUARD',
        flowType: 'dev',
        mode: 'interactive',
        transport: 'tmux',
        status: 'failed',
        slotId,
        taskFile: null,
        createdAt: now,
        updatedAt: now,
        decisions: [],
        metrics: { nudgeCount: 0, runner, model: 'fixture' },
        steps: [],
        agentContexts: [
          {
            id: 'dev',
            role: 'dev',
            status: 'working',
            runner,
            slotId,
            target: { session, paneId, target: paneId },
            taskFile: null,
          },
        ],
      },
    });
  }
  const repo = path.join(temporary, 'guard-reservation');
  gitInit(repo);
  const slotId = `coherence-reservation-${randomUUID()}`;
  const runId = randomUUID();
  const now = new Date().toISOString();
  fixtures.push({
    repo,
    slotId,
    runId,
    handoff: true,
    slot: {
      id: slotId,
      project,
      platform: 'cli',
      repo,
      session: slotId,
      enabled: true,
      mode: 'dispatch',
    },
    status: {
      slot: slotId,
      lifecycle: 'busy',
      phase: 'working',
      current_run_id: runId,
      handoff_run_id: randomUUID(),
    },
    run: {
      id: runId,
      project,
      ticketOrPr: 'COHERENCE-RESERVATION',
      flowType: 'dev',
      mode: 'interactive',
      transport: 'tmux',
      status: 'failed',
      slotId,
      taskFile: null,
      createdAt: now,
      updatedAt: now,
      decisions: [],
      metrics: { nudgeCount: 0, runner: 'claude', model: 'fixture' },
      steps: [],
    },
  });
  for (const fault of [
    'early-cancel',
    'cancel-ancillary',
    'complete-ancillary',
    'notify',
    'stale-provider',
    'provider-group',
    'preexisting-provider',
    'replaced-provider',
    'legacy-provider',
    'restarted-provider',
    'child-provider',
    'metadata-provider',
  ]) {
    const repo = path.join(temporary, `guard-${fault}`);
    gitInit(repo);
    const slotId = `coherence-${fault}-${randomUUID()}`;
    const runId = randomUUID();
    const now = new Date().toISOString();
    fixtures.push({
      fault,
      repo,
      slotId,
      runId,
      slot: {
        id: slotId,
        project,
        platform: 'cli',
        repo,
        session: slotId,
        enabled: true,
        mode: 'dispatch',
        resources: { 'owned-server': {} },
      },
      status: {
        slot: slotId,
        lifecycle: 'busy',
        phase: 'working',
        current_run_id: fault === 'child-provider' ? randomUUID() : runId,
      },
      run: {
        id: runId,
        project,
        ticketOrPr: 'COHERENCE-FAILURE',
        flowType: 'dev',
        mode: 'interactive',
        transport: 'tmux',
        status: 'blocked',
        prNumber: 1,
        slotId,
        taskFile: null,
        createdAt: now,
        updatedAt: now,
        decisions: [],
        metrics: { nudgeCount: 0, runner: 'claude', model: 'fixture' },
        steps: [],
      },
    });
  }
  return fixtures;
}

export function proveCleanupGuards({
  fixtures,
  rpc,
  readStatus,
  check,
  executable,
  configFile,
  temporary,
}) {
  for (const fixture of fixtures) {
    if (
      ['legacy-provider', 'restarted-provider', 'child-provider', 'metadata-provider'].includes(
        fixture.fault,
      )
    )
      continue;
    if (fixture.fault) {
      if (
        ['stale-provider', 'provider-group', 'preexisting-provider', 'replaced-provider'].includes(
          fixture.fault,
        )
      ) {
        if (fixture.fault === 'preexisting-provider')
          execFileSync(
            process.execPath,
            [executable, '--server-boot', path.join(fixture.repo, 'owned-server.pid')],
            { cwd: fixture.repo, env: { ...process.env, NATIVE_COHERENCE_CONFIG: configFile } },
          );
        const acquired = rpc('runtime.capability.acquire', {
          slotId: fixture.slotId,
          capabilityId: 'owned-server',
          ownerRunId: fixture.runId,
          proofRequirement: {
            capabilityId: 'owned-server',
            reason: 'Birth identity regression proof',
            mode: 'state',
          },
        });
        assert.equal(acquired.ok, true, JSON.stringify(acquired));
        if (fixture.fault === 'stale-provider')
          assert.equal(
            acquired.lease.providerProcesses.length,
            0,
            'A stale sidecar must grant no provider ownership',
          );
        if (fixture.fault === 'preexisting-provider')
          assert.equal(
            acquired.lease.providerProcesses.length,
            0,
            'Idempotent boot must not claim the preexisting unleased server',
          );
        if (fixture.fault === 'replaced-provider') {
          const pidFile = path.join(fixture.repo, 'owned-server.pid');
          renameSync(pidFile, path.join(fixture.repo, 'owned-server.original.pid'));
          // The replacement's cwd lies outside the slot, so the cwd census cannot protect it.
          execFileSync(process.execPath, [executable, '--server-boot', pidFile], {
            cwd: temporary,
            env: { ...process.env, NATIVE_COHERENCE_CONFIG: configFile },
          });
        }
        if (['provider-group', 'replaced-provider'].includes(fixture.fault)) {
          const released = rpc('runtime.capability.release', {
            slotId: fixture.slotId,
            ownerRunId: fixture.runId,
            keepWarm: false,
          });
          assert.equal(
            released.ok,
            false,
            'Provider shutdown must verify recorded kernel identity',
          );
          assert.match(JSON.stringify(released.failures), /process ownership changed/);
        }
      }
      try {
        rpc(
          fixture.fault.startsWith('cancel') || fixture.fault === 'early-cancel'
            ? 'run.cancel'
            : 'run.forceComplete',
          { runId: fixture.runId },
        );
      } catch (error) {
        assert.match(String(error), /Fixture .* failed|Cleanup failed/);
      }
      const slot = readStatus().slots.find((candidate) => candidate.slot === fixture.slotId);
      assert.equal(slot.lifecycle, 'held', `${fixture.fault} must settle to held`);
      assert.equal(slot.phase, 'occupied', `${fixture.fault} must clear the releasing fence`);
      assert.equal(slot.current_run_id, null);
      assert.ok(slot.held_reason);
      if (
        ['stale-provider', 'provider-group', 'preexisting-provider', 'replaced-provider'].includes(
          fixture.fault,
        )
      ) {
        const pid = Number(readFileSync(path.join(fixture.repo, 'owned-server.pid'), 'utf8'));
        process.kill(pid, 0);
      }
      check(`${fixture.fault} preserves occupancy and settles its exact owned fence`);
      continue;
    }
    const completed = rpc('run.forceComplete', { runId: fixture.runId });
    assert.equal(completed.run.status, 'done');
    const slot = readStatus().slots.find((candidate) => candidate.slot === fixture.slotId);
    if (fixture.handoff) {
      assert.match(
        completed.run.slotTeardownSkipped ?? '',
        /handoff/,
        'Handoff cleanup remains deferred',
      );
      assert.equal(slot.current_run_id, fixture.runId);
      assert.equal(slot.handoff_run_id, fixture.status.handoff_run_id);
      check('completion preserves another handoff reservation');
    } else {
      assert.ok(completed.run.slotTeardownSkipped, 'Unverified live panes remain protected');
      assert.equal(slot.current_run_id, null);
      assert.equal(slot.lifecycle, 'held');
      assert.equal(slot.phase, 'occupied');
      assert.ok(slot.held_reason);
      if (fixture.runner === 'claude')
        assert.match(
          slot.held_reason,
          /Recorded worker pane process/,
          'Recorded non-runner pane root remains occupied',
        );
      execFileSync('tmux', ['has-session', '-t', `=${fixture.session}`]);
      assert.equal(
        execFileSync('tmux', ['display-message', '-p', '-t', fixture.paneId, '#{pane_dead}'], {
          encoding: 'utf8',
        }).trim(),
        '0',
      );
      check(`${fixture.runner} unverified live pane is preserved and explicitly held`);
    }
  }
}

export function prepareGoneContext(repo) {
  const session = `coherence-gone-${randomUUID()}`;
  const paneId = execFileSync(
    'tmux',
    ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, '-c', repo],
    { encoding: 'utf8' },
  ).trim();
  assert.ok(paneId, 'Historical fixture must record its exact created pane');
  execFileSync('tmux', ['kill-session', '-t', `=${session}`]);
  return {
    id: 'historical',
    role: 'dev',
    status: 'complete',
    runner: 'none',
    target: { session, paneId, target: paneId },
  };
}
