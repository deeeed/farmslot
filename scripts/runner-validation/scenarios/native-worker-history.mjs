import assert from 'node:assert/strict';

import { rpc } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

/** Replay every page for the explicitly selected task, preserving absolute cursors. */
export function readPinnedWorkerHistory(runId, contextId, leaseId) {
  const target = pinnedWorkerTarget(runId, contextId, leaseId);
  const events = [];
  let page = rpc('native.session.read', { ...target, limit: 500 });
  const startAfter = page.scope.startAfter;
  for (;;) {
    assert.equal(page.session.id, target.sessionId);
    assert.equal(page.session.executionNodeId, target.executionNodeId);
    assert.equal(page.session.workerLeaseId, leaseId);
    assert.equal(page.scope.leaseId, leaseId);
    assert.equal(page.scope.startAfter, startAfter);
    for (const event of page.events) {
      assert.equal(event.sequence, (events.at(-1)?.sequence ?? startAfter) + 1);
      assert.ok(event.sequence <= page.scope.endAt);
      events.push(event);
    }
    assert.equal(page.cursor, events.at(-1)?.sequence ?? startAfter);
    if (!page.hasMore) {
      assert.equal(page.cursor, page.scope.endAt);
      return { ...page, events };
    }
    assert.ok(page.events.length, 'History pagination made no progress');
    page = rpc('native.session.read', { ...target, after: page.cursor, limit: 500 });
  }
}

export function assertWorkerHistoryTransfer(before, source, successor) {
  assert.equal(source.scope.leaseId, before.scope.leaseId);
  assert.equal(source.scope.released, true);
  assert.equal(source.scope.startAfter, before.scope.startAfter);
  assert.ok(source.scope.endAt >= before.scope.endAt);
  assert.deepEqual(source.events.slice(0, before.events.length), before.events);
  assert.deepEqual(source.pendingRequests, []);
  assert.notEqual(successor.scope.leaseId, source.scope.leaseId);
  assert.equal(successor.scope.startAfter, source.scope.endAt);
  for (const key of ['id', 'generation', 'nativeSessionId', 'cwd', 'workerLeaseId'])
    assert.equal(source.session[key], before.session[key], `Source history changed ${key}`);
  const sourceCommands = new Set(source.commands.map((command) => command.commandId));
  for (const command of before.commands) assert.ok(sourceCommands.has(command.commandId));
  for (const command of successor.commands) assert.ok(!sourceCommands.has(command.commandId));
  assert.ok(successor.events.every((event) => event.sequence > source.scope.endAt));
}
