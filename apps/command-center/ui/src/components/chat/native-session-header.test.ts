import assert from 'node:assert/strict';
import test from 'node:test';

import { litText } from '../../testing/lit-text.js';

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
  const output = litText(renderNativeSessionHeader(context));
  assert.match(output, /Refreshing history/);
  assert.doesNotMatch(output, /source unavailable|Replaying history/);
  assert.match(
    litText(renderNativeSessionHeader({ ...context, connected: false })),
    /Reconnecting/,
  );
});
