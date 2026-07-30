import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  discoverWorkspaces,
  runWorkspaceQuality,
  workspaceSteps,
  workspaceSummaryLines,
  workspaceTimingArtifact,
} from './run-workspace-quality.mjs';

function fakeClock(durations) {
  let current = 0;
  const pending = [...durations];
  let started = false;
  return () => {
    if (!started) {
      started = true;
      return current;
    }
    started = false;
    current += pending.shift() ?? 0;
    return current;
  };
}

function fakeSpawn(statuses) {
  const pending = [...statuses];
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args].join(' '));
    return { status: pending.shift() ?? 0 };
  };
  return { spawn, calls };
}

const WORKSPACES = [
  { name: '@farmslot/protocol', relativeDir: 'packages/protocol' },
  { name: '@farmslot/gateway', relativeDir: 'services/gateway' },
];

function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-workspace-quality-'));
  const write = (dir, pkg) => {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify(pkg));
  };
  write('packages/theme', { name: '@farmslot/theme', scripts: { quality: 'echo theme' } });
  write('packages/protocol', { name: '@farmslot/protocol', scripts: { quality: 'echo protocol' } });
  write('services/gateway', { name: '@farmslot/gateway', scripts: { quality: 'echo gateway' } });
  mkdirSync(path.join(root, 'packages/not-a-workspace'), { recursive: true });
  return root;
}

test('workspace discovery is deterministic and skips dirs without a package.json', () => {
  const root = fixtureRoot();
  try {
    const discovered = discoverWorkspaces(root);
    assert.deepEqual(
      discovered.map((workspace) => workspace.name),
      ['@farmslot/gateway', '@farmslot/protocol', '@farmslot/theme'],
    );
    assert.deepEqual(discovered, discoverWorkspaces(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace missing a quality script is rejected', () => {
  const root = fixtureRoot();
  try {
    mkdirSync(path.join(root, 'packages/broken'), { recursive: true });
    writeFileSync(
      path.join(root, 'packages/broken/package.json'),
      JSON.stringify({ name: '@farmslot/broken' }),
    );
    assert.throws(() => discoverWorkspaces(root), /must define a quality script/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each workspace becomes one named, timed step', () => {
  assert.deepEqual(workspaceSteps(WORKSPACES), [
    ['@farmslot/protocol', ['yarn', 'workspace', '@farmslot/protocol', 'quality']],
    ['@farmslot/gateway', ['yarn', 'workspace', '@farmslot/gateway', 'quality']],
  ]);
});

test('workspace durations are reported by name in the ranked summary', () => {
  const { spawn, calls } = fakeSpawn([0, 0]);
  const lines = [];
  const { records, failure } = runWorkspaceQuality(WORKSPACES, {
    spawn,
    now: fakeClock([2000, 61_000]),
    log: (line) => lines.push(line),
  });

  assert.equal(failure, null);
  assert.deepEqual(calls, [
    'yarn workspace @farmslot/protocol quality',
    'yarn workspace @farmslot/gateway quality',
  ]);
  assert.ok(
    lines.includes('[workspace-quality] done step="@farmslot/protocol" status=ok ms=2000 (2.0s)'),
  );

  const summary = workspaceSummaryLines(records, failure);
  assert.equal(
    summary[0],
    '\n[workspace-quality] summary steps=2 ok=2 failed=0 total_ms=63000 total=1m 03s',
  );
  assert.deepEqual(summary.slice(1), [
    '[workspace-quality] slowest:',
    '[workspace-quality]   1. @farmslot/gateway ms=61000 (1m 01s)',
    '[workspace-quality]   2. @farmslot/protocol ms=2000 (2.0s)',
  ]);
});

test('workspace timing artifact links named durations for CI parsing', () => {
  const { spawn } = fakeSpawn([0, 0]);
  const { records, failure } = runWorkspaceQuality(WORKSPACES, {
    spawn,
    now: fakeClock([2000, 61_000]),
    log: () => {},
  });

  const artifact = workspaceTimingArtifact(records, failure);
  assert.equal(artifact.kind, 'workspace-quality');
  assert.equal(artifact.status, 'ok');
  assert.equal(artifact.totalMs, 63_000);
  assert.deepEqual(
    artifact.steps.map((step) => [step.label, step.ms, step.status]),
    [
      ['@farmslot/protocol', 2000, 'ok'],
      ['@farmslot/gateway', 61_000, 'ok'],
    ],
  );
  assert.deepEqual(artifact.slowest[0], { label: '@farmslot/gateway', ms: 61_000 });
});

test('a failing workspace stops the run and is named in output and artifact', () => {
  const { spawn, calls } = fakeSpawn([4]);
  const { records, failure } = runWorkspaceQuality(WORKSPACES, {
    spawn,
    now: fakeClock([1500]),
    log: () => {},
  });

  assert.deepEqual(failure, { label: '@farmslot/protocol', status: 4 });
  assert.deepEqual(calls, ['yarn workspace @farmslot/protocol quality']);

  const summary = workspaceSummaryLines(records, failure);
  assert.equal(summary[1], '[workspace-quality] failed step="@farmslot/protocol" status=4');

  const artifact = workspaceTimingArtifact(records, failure);
  assert.equal(artifact.status, 'fail');
  assert.equal(artifact.failedStep, '@farmslot/protocol');
});
