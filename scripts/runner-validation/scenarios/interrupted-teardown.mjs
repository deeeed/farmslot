import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function runScenario(c) {
  await c.start({ scripted: { mode: 'scenario', scenario: 'late-ack', stepDelayMs: 1 } });
  const run = await c.wait('run reaches the gate', (run) =>
    run.decisions.some((decision) => !decision.resolvedAt && decision.type === 'engine_human_gate'),
  );
  const branch = c.git('branch', '--show-current');
  const head = c.git('rev-parse', 'HEAD');
  await writeFile(path.join(c.stack.holds, 'git'), 'fetch');
  const gate = run.decisions.find(
    (decision) => !decision.resolvedAt && decision.type === 'engine_human_gate',
  );
  await c.resolve(gate, 'close-as-shipped');
  await c.wait('release reaches its git checkpoint', async (run) => {
    const { existsSync } = await import('node:fs');
    return run.status === 'done' && existsSync(path.join(c.stack.holds, 'git.hit'));
  });
  await c.stack.restartGateway({
    whileDown: async () => {
      await unlink(path.join(c.stack.holds, 'git'));
    },
  });
  await c.wait('interrupted teardown recovers', async () => {
    const { fleet } = await c.call('fleet.status');
    return fleet.slots.find((slot) => slot.slot === c.slotId)?.lifecycle === 'ready';
  });
  assert.equal(c.git('rev-parse', `refs/heads/${branch}`), head);
  assert.equal(c.git('rev-parse', 'HEAD'), head);
}
