import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NativeSessionClient } from '../../../packages/agent-runtime/src/native/client.ts';

export async function proveQueuedLeaseOwnership({ env, repo, configFile, mode, check }) {
  mode({ holdMs: 45000 });
  const host = JSON.parse(
    readFileSync(path.join(env.FARMSLOT_NATIVE_STATE_DIR, 'host.json'), 'utf8'),
  );
  const client = new NativeSessionClient(
    env.FARMSLOT_NATIVE_STATE_DIR,
    host.executionNodeId ?? 'local',
  );
  const owner = `fixture-${randomUUID()}`;
  const leaseA = randomUUID();
  const leaseB = randomUUID();
  const launch = {
    leaseId: leaseA,
    safetyTier: 'full-auto',
    environment: {
      set: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, NATIVE_COHERENCE_CONFIG: configFile },
      unset: [],
    },
  };
  const session = await client.ensureWorker(
    owner,
    { sessionId: randomUUID(), runner: 'claude', cwd: repo, model: 'opus' },
    launch,
  );
  const target = { sessionId: session.id, generation: session.generation, leaseId: leaseA };
  await client.sendWorker(owner, target, 'lease-active', 'hold-turn');
  const queued = await client.sendWorker(owner, target, 'lease-queued', 'private lease steering');
  assert.equal(queued.queued, true);
  await client.cancelWorker(owner, { ...target, leaseId: leaseB, sourceLeaseId: leaseA });
  const prior = await client.readWorker(owner, session.id, leaseA);
  assert.equal(
    prior.commands.find((command) => command.commandId === 'lease-queued')?.outcome,
    'interrupted',
    'Handoff receipt must remain with its original task lease',
  );
  assert.equal(
    (await client.readWorker(owner, session.id, leaseB)).commands.some(
      (command) => command.commandId === 'lease-queued',
    ),
    false,
  );
  assert.ok(
    !readFileSync(path.join(path.dirname(configFile), 'inputs.jsonl'), 'utf8').includes(
      'private lease steering',
    ),
  );
  await assert.rejects(
    client.sendWorker(owner, target, 'stale-lease', 'must not run'),
    /lease|generation|ownership/i,
  );
  check(
    'handoff cancellation retains unsubmitted receipts in the original lease through the native host endpoint',
  );
}
