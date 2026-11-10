import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { type EventFrame, Events, type MonitorViolation } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const server = await import('../server.js');
const frames: EventFrame[] = [];
mock.module('../server.js', {
  namedExports: {
    ...server,
    broadcast: (frame: EventFrame) => {
      frames.push(frame);
      server.broadcast(frame);
    },
  },
});
const { notifyPublicationGateStall } = await import('./publication-gate-notification.js');
const { __drainAutoRecoveryForTest, __resetAutoRecoveryForTest, routeEventToAutoRecovery } =
  await import('../auto-recovery/watcher.js');
const { activeRun, cleanupRun, makeProject } =
  await import('../auto-recovery/watcher-test-fixtures.js');
const { getRun, updateRun } = await import('../runs/store.js');

for (const projectAvailable of [true, false]) {
  test(`production gate notification is flag-only with a failed audit volume, project available=${projectAvailable}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'gate-notification-'));
    const audit = path.join(root, 'not-a-directory');
    await writeFile(audit, 'synthetic unwritable audit destination');
    const previous = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = audit;
    const project = projectAvailable ? await makeProject(t, {}) : 'synthetic-missing-project';
    const run = activeRun(project, { slotId: 'synthetic-gate-slot', status: 'human-gating' });
    __resetAutoRecoveryForTest();
    t.after(async () => {
      __resetAutoRecoveryForTest();
      await cleanupRun(run.id);
      if (previous === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
      else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    });
    const violation: MonitorViolation = {
      slotId: run.slotId!,
      target: run.id,
      type: 'waiting',
      message: 'Synthetic overdue human-gate',
      nudgeSent: null,
      timestamp: new Date().toISOString(),
    };
    // Prove the ordinary production recovery handler hits this failed audit volume.
    const warnings = t.mock.method(console, 'warn', () => {});
    routeEventToAutoRecovery(Events.MONITOR_VIOLATION, { violation });
    await __drainAutoRecoveryForTest();
    assert.equal(getRun(run.id)?.engineState?.intelligenceAuditDegraded, true);
    assert.ok(
      warnings.mock.calls.some(({ arguments: args }) => String(args[0]).includes('write_failed')),
    );
    updateRun(run.id, { engineState: run.engineState });
    __resetAutoRecoveryForTest();
    frames.length = 0;
    const before = structuredClone(getRun(run.id));
    notifyPublicationGateStall(violation);
    await __drainAutoRecoveryForTest();
    assert.deepEqual(frames, [
      { type: 'event', event: Events.MONITOR_VIOLATION, payload: { violation } },
    ]);
    assert.deepEqual(
      getRun(run.id),
      before,
      'no audit-degraded, dead-letter, or lifecycle mutation',
    );
  });
}
