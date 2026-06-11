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

test('tmux worker watch signature ignores volatile process observedAt churn', () => {
  const panes: NodeTmuxPane[] = [
    {
      session: 'slot-1',
      window: '1',
      pane: '1',
      target: '%1',
      command: 'claude',
      signals: {
        process: {
          label: 'process idle · cpu 0%',
          observedAt: 1_000_000,
          active: false,
          cpuPct: 0,
          runningProcesses: 0,
        },
      },
    },
  ];
  const nextPanes: NodeTmuxPane[] = [
    {
      ...panes[0],
      signals: {
        process: {
          label: 'process idle · cpu 0.1%',
          observedAt: 1_001_000,
          active: false,
          cpuPct: 0.1,
          runningProcesses: 0,
        },
      },
    },
  ];

  assert.equal(panesSignature(panes, 1_001_000), panesSignature(nextPanes, 1_002_000));
});

test('tmux worker watch signature changes when process activity changes', () => {
  const panes: NodeTmuxPane[] = [
    {
      session: 'slot-1',
      window: '1',
      pane: '1',
      target: '%1',
      command: 'claude',
      signals: {
        process: {
          label: 'process idle · cpu 0%',
          observedAt: 1_000_000,
          active: false,
          cpuPct: 0,
          runningProcesses: 0,
        },
      },
    },
  ];
  const activePanes: NodeTmuxPane[] = [
    {
      ...panes[0],
      signals: {
        process: {
          label: 'process active · cpu 6%',
          observedAt: 1_001_000,
          active: true,
          cpuPct: 6,
          runningProcesses: 1,
        },
      },
    },
  ];

  assert.notEqual(panesSignature(panes, 1_001_000), panesSignature(activePanes, 1_002_000));
});
