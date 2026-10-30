import assert from 'node:assert/strict';
import test from 'node:test';

import { litBinding, litText } from '../../testing/lit-text.js';

import { renderNativeReadStatus } from './native-read-status-view.js';
import { renderNativeSessionHeader } from './native-session-header.js';

test('a superseded history read shows Refreshing history rather than a source error', () => {
  const context = {
    sessions: [],
    selectedId: 'session',
    selectedNodeId: 'node',
    connected: true,
    caughtUp: false,
    refreshingHistory: true,
    busy: false,
    workspace: false,
    workspaceAllowed: false,
    taskHistory: true,
    fullscreen: false,
    requestCount: 0,
    toggleFullscreen() {},
    select() {},
    refresh() {},
    toggleWorkspace() {},
    sessionChoice: () => 'session',
  };
  const row = litBinding(renderNativeSessionHeader(context), '.context=');
  assert(row && typeof row === 'object');
  assert.equal(Reflect.get(row, 'refreshingHistory'), true);
  const output = litText(renderNativeReadStatus({ ...context, selected: true }));
  assert.match(output, /Refreshing history/);
  assert.doesNotMatch(output, /source unavailable|Replaying history/);
  assert.match(
    litText(renderNativeReadStatus({ ...context, selected: true, connected: false })),
    /Reconnecting/,
  );
});

test('the fixed row retains saved-read proof wording and the failure cause', () => {
  const text = litText(
    renderNativeReadStatus(
      {
        connected: true,
        selected: true,
        caughtUp: false,
        taskHistory: true,
        saved: true,
        observedAt: 90_000,
        unavailableSince: 100_000,
        readError: 'Task history boundaries changed',
        refresh() {},
      },
      160_000,
    ),
  );
  assert.match(text, /Saved conversation history/);
  assert.match(text, /Actions wait for a current read/);
  assert.match(text, /title=Task history boundaries changed/);
  assert.match(text, /Unavailable/);
});

test('a continuously superseded read gains the canonical saved caption at the shared grace boundary', () => {
  const context = {
    connected: true,
    selected: true,
    caughtUp: false,
    taskHistory: true,
    refreshingHistory: true,
    observedAt: 100_000,
    historyObservation: {
      status: 'stale' as const,
      data: {},
      observedAt: 100_000,
      error: { code: 'RESOURCE_OBSERVATION_CHANGED', message: 'changed' },
    },
    refresh() {},
  };
  assert.doesNotMatch(
    litText(renderNativeReadStatus(context, 159_999)),
    /Saved conversation history/,
  );
  assert.match(litText(renderNativeReadStatus(context, 160_000)), /Saved conversation history/);
});
