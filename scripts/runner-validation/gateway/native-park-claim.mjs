import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { FLOW_STEPS } from '@farmslot/protocol';

export async function proveParkOccupiedClaim({
  rpc,
  runId,
  slotId,
  repo,
  temporary,
  root,
  statusFile,
  session,
  restartGateway,
  check,
}) {
  appendFileSync(path.join(repo, '.git/info/exclude'), '\n.task/\n');
  // Setup a publication wait around the real fixture worker; park/restore remain real RPC actions.
  await restartGateway(() => {
    const file = path.join(root, '.runs', `${runId}.json`);
    const run = JSON.parse(readFileSync(file, 'utf8'));
    run.mode = 'autonomous';
    run.status = 'human-gating';
    delete run.completionPolicy;
    delete run.devInteractiveProfile;
    run.steps = FLOW_STEPS.dev.map((name, index) => ({
      name,
      status:
        name === 'human-gate'
          ? 'running'
          : index < FLOW_STEPS.dev.indexOf('human-gate')
            ? 'done'
            : 'pending',
      ...(name === 'complete' ? { outputs: { slotDisposition: 'gate-held' } } : {}),
    }));
    writeFileSync(file, JSON.stringify(run));
  });
  const machine = rpc('fleet.status', { forceRefresh: true }).fleet.slots.find(
    (slot) => slot.slot === slotId,
  ).machine;
  assert.ok(machine, 'The refreshed fixture slot must identify its machine');
  const selector = { kind: 'include', runIds: [runId] };
  const preview = rpc('machine.pause.preview', { machine, mode: 'release', selector });
  const target = preview.runs.find((run) => run.runId === runId);
  assert.equal(target?.eligibility.eligible, true, JSON.stringify(target));
  const parked = rpc('machine.pause.execute', {
    machine,
    mode: 'release',
    previewId: preview.previewId,
    reviewedTargets: [{ runId, generation: target.generation }],
    operationId: randomUUID(),
  });
  assert.equal(parked.ok, true, JSON.stringify(parked));
  assert.equal(
    rpc('run.get', { runId }).run.park.slotDisposition,
    'freed',
    'Publication park must actually free the slot',
  );
  const head = readFileSync(path.join(repo, '.git/HEAD'), 'utf8');
  const ready = JSON.parse(readFileSync(statusFile, 'utf8')).slots.find(
    (slot) => slot.slot === slotId,
  );
  const ownerSession = `${session}-owner`;
  execFileSync('tmux', ['new-session', '-d', '-s', ownerSession, '-c', repo, 'sleep 600']);
  await restartGateway(() => {
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    Object.assign(
      status.slots.find((slot) => slot.slot === slotId),
      {
        lifecycle: 'held',
        phase: 'occupied',
        current_run_id: runId,
        held_reason: 'Fixture occupied owner workspace',
        slot_epoch: (ready.slot_epoch ?? 0) + 1,
      },
    );
    writeFileSync(statusFile, JSON.stringify(status));
  });
  const occupiedOwner = rpc('machine.pause.restore', { machine, selector }).runs.find(
    (run) => run.runId === runId,
  );
  assert.equal(
    occupiedOwner.eligibility.eligible,
    false,
    'Occupied park owner must refuse restore',
  );
  assert.match(JSON.stringify(occupiedOwner), /occupied/);
  assert.equal(readFileSync(path.join(repo, '.git/HEAD'), 'utf8'), head);
  execFileSync('tmux', ['has-session', '-t', `=${ownerSession}`]);
  execFileSync('tmux', ['kill-session', '-t', `=${ownerSession}`]);
  await restartGateway(() => {
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    const row = status.slots.find((slot) => slot.slot === slotId);
    const epoch = row.slot_epoch + 1;
    Object.assign(row, ready, { slot_epoch: epoch });
    writeFileSync(statusFile, JSON.stringify(status));
  });
  check('park restore also refuses an occupied hold that still names its original owner');
  const restore = rpc('machine.pause.restore', { machine, selector });
  const selected = restore.runs.find((run) => run.runId === runId);
  assert.equal(selected?.eligibility.eligible, true, JSON.stringify(selected));
  writeFileSync(
    path.join(temporary, 'park-claim-target.json'),
    JSON.stringify({ runId, slotId, repo, session, statusFile }),
  );
  const result = rpc('machine.pause.restore', {
    machine,
    selector,
    execute: true,
    previewId: restore.previewId,
    reviewedTargets: [{ runId, generation: selected.generation }],
    operationId: randomUUID(),
  });
  const beforeFile = path.join(temporary, 'park-claim-before.json');
  assert.ok(existsSync(beforeFile), 'The production park restore must reach the claim race');
  const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
  const after = JSON.parse(readFileSync(statusFile, 'utf8')).slots.find(
    (slot) => slot.slot === slotId,
  );
  for (const key of [
    'lifecycle',
    'phase',
    'current_run_id',
    'handoff_run_id',
    'held_reason',
    'slot_epoch',
  ])
    assert.equal(after[key], before[key], 'Occupied park restore must preserve the slot claim');
  assert.equal(result.ok, false);
  assert.equal(readFileSync(path.join(repo, '.git/HEAD'), 'utf8'), head);
  execFileSync('tmux', ['has-session', '-t', `=${session}`]);
  check(
    'park restore refuses a new occupied hold at the real claim CAS and preserves workspace, owner and epoch',
  );
}
