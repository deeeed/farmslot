import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeTmuxPane } from '@farmslot/protocol';

import { panesSignature } from './tmux-worker-watch.js';

test('tmux worker watch signature changes when runner signals become stale', () => {
  const observedAt = 1_000_000;
  const panes: NodeTmuxPane[] = [
    {
      session: 'slot-1',
      window: '1',
      pane: '1',
      target: '%1',
      command: 'claude',
      signals: {
        hook: {
          label: 'hook Stop',
          event: 'Stop',
          observedAt,
        },
      },
    },
  ];

  assert.notEqual(
    panesSignature(panes, observedAt + 1_000),
    panesSignature(panes, observedAt + 121_000),
  );
});
