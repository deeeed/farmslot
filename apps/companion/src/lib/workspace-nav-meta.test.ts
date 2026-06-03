import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import type { SlotWorkspaceGateSummary, SlotWorkspaceRetroSummary } from './slot-workspace';
import {
  decisionWorkspaceNavMeta,
  workspaceGateNavMeta,
  workspaceRetroNavMeta,
} from './workspace-nav-meta';

const decision = { id: 'decision-1' } as RunDecision;

test('workspaceGateNavMeta summarizes pending gate files and diff', () => {
  const gate: SlotWorkspaceGateSummary = {
    decision,
    label: 'Review workspace',
    title: 'Review',
    summary: 'Review pending',
    tone: 'review',
    resolved: false,
    primaryArtifactPath: 'inputs/diff.txt',
    artifactPaths: ['inputs/diff.txt', 'outputs/review.md'],
    metrics: [{ label: 'Diff', value: '+12 -3' }],
  };

  assert.equal(workspaceGateNavMeta(gate), 'pending · 2 files · +12 -3');
});

test('workspaceGateNavMeta distinguishes ready and warning resolved states', () => {
  const readyGate: SlotWorkspaceGateSummary = {
    decision,
    label: 'Ready workspace',
    title: 'Ready',
    summary: 'Ready',
    tone: 'ready',
    resolved: true,
    primaryArtifactPath: 'outputs/ready.md',
    artifactPaths: ['outputs/ready.md'],
    metrics: [],
  };
  const warningGate: SlotWorkspaceGateSummary = {
    ...readyGate,
    label: 'No-change review',
    tone: 'warning',
    artifactPaths: [],
  };

  assert.equal(workspaceGateNavMeta(readyGate), 'ready · 1 file');
  assert.equal(workspaceGateNavMeta(warningGate), 'warning · 0 files');
});

test('workspaceRetroNavMeta summarizes retro files and before-after pairs', () => {
  const retro: SlotWorkspaceRetroSummary = {
    decision,
    title: 'Retro',
    summary: 'Recorded',
    pending: false,
    statusLabel: 'recorded',
    primaryArtifactPath: 'outputs/retro.md',
    artifactPaths: ['outputs/retro.md', 'screens/after.png'],
    visualPairCount: 1,
    primaryVisualPair: {
      beforePath: 'screens/before.png',
      afterPath: 'screens/after.png',
      stem: 'screens',
    },
    metrics: [],
  };

  assert.equal(workspaceRetroNavMeta(retro), 'recorded · 2 files · 1 before→after');
});

test('decisionWorkspaceNavMeta summarizes pending inbox decision context', () => {
  assert.equal(
    decisionWorkspaceNavMeta({
      statusLabel: 'pending',
      artifactCount: 3,
      diffValue: '2 files, +12/-3',
      visualPairCount: 1,
    }),
    'pending · 3 files · 2 files, +12/-3 · 1 before→after',
  );
});
