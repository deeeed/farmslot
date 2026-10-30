import assert from 'node:assert/strict';
import test from 'node:test';

import type { PendingDecision } from '@farmslot/protocol';

import { NotificationTrayModel, type TrayItem } from './notification-tray-model.js';

type DecisionNotice = Pick<
  PendingDecision,
  'id' | 'type' | 'title' | 'description' | 'slotId' | 'runMeta'
>;
const decision = (id: string): DecisionNotice => ({
  id,
  type: 'engine_human_gate',
  title: 'Review requested',
  description: 'Inspect the recorded result',
  slotId: 'slot-1',
  runMeta: { runId: 'run-1', flowType: 'dev', ticketOrPr: 'TASK-1' },
});

test('one subject alerts once while open, clears from current facts and alerts when it returns', () => {
  const alerts: string[] = [];
  const model = new NotificationTrayModel((item) => alerts.push(item.id));
  model.setOwner('owner-a');
  model.decisions('owner-a', [], true);
  model.decisions('owner-a', [decision('first'), decision('second')], true);
  assert.equal(model.items.length, 1);
  assert.equal(model.items[0]?.route, '#run/run-1');
  assert.deepEqual(alerts, ['run:run-1:decision']);
  model.decisions('owner-a', [decision('second')], true);
  model.decisions('owner-a', [decision('second')], false);
  model.decisions('owner-a', [decision('second')], true);
  assert.equal(
    alerts.length,
    1,
    'a reconnect or another decision for the same open subject is not a recurrence',
  );
  model.decisions('owner-a', [], true);
  assert.deepEqual(model.items, []);
  model.decisions('owner-a', [decision('third')], true);
  assert.equal(
    alerts.length,
    2,
    'a genuinely returned condition alerts without a time-window guess',
  );
});

test('first hydration is visible without ringing, and old authority callbacks cannot restore it', () => {
  const alerts: string[] = [];
  const model = new NotificationTrayModel((item) => alerts.push(item.id));
  model.setOwner('owner-a');
  model.decisions('owner-a', [decision('first')], true);
  assert.equal(model.items.length, 1);
  assert.deepEqual(alerts, []);
  model.setOwner('owner-b');
  model.decisions('owner-a', [decision('late')], true);
  assert.deepEqual(model.items, []);
});

test('several mounted readers share one quiet item and retain it until the last source clears', () => {
  const alerts: string[] = [];
  const model = new NotificationTrayModel((item) => alerts.push(item.id));
  model.setOwner('owner-a');
  const sourceA = {},
    sourceB = {};
  const item: TrayItem = {
    id: 'run:run-1:read',
    title: 'Could not refresh task progress',
    body: 'Unavailable',
    route: '#run/run-1',
    needsYou: false,
    current: true,
  };
  model.set(sourceA, 'owner-a', [item]);
  model.set(sourceB, 'owner-a', [item]);
  assert.equal(model.items.length, 1);
  model.clear(sourceA);
  assert.equal(model.items.length, 1);
  model.clear(sourceB);
  assert.deepEqual(model.items, []);
  assert.deepEqual(alerts, []);
});

test('slot conditions deduplicate without run metadata and distinct conditions stay separate', () => {
  const model = new NotificationTrayModel(() => assert.fail('Initial hydration must stay quiet'));
  model.setOwner('owner');
  model.decisions(
    'owner',
    [
      { ...decision('one'), runMeta: undefined },
      { ...decision('two'), runMeta: undefined },
      { ...decision('blocked'), type: 'blocked_alert', runMeta: undefined },
    ],
    true,
  );
  assert.equal(model.items.length, 2);
  assert.equal(model.items[0]?.route, '#slot/slot-1');
});
