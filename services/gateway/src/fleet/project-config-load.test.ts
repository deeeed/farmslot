// project-config-load.test.ts — the loader must actually PRODUCE every field
// ProjectConfig declares.
//
// `runtimeCapabilities` was declared on the contract and read by host-pressure
// admission while nothing ever assigned it, so a project's opt-in was silently
// unreachable. A type that nothing produces typechecks perfectly, so this is a
// behavioural test against a real project.json on disk.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** A directory the root resolver accepts, with the project fixtures under it. */
function makeFakeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-project-load-'));
  writeFileSync(path.join(root, 'CLAUDE.md'), '# fake root\n');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/sh\n');
  mkdirSync(path.join(root, 'services', 'gateway'), { recursive: true });
  writeFileSync(path.join(root, 'services', 'gateway', 'package.json'), '{}');
  return root;
}

const provider = {
  label: 'Browser CDP',
  version: '1.0.0',
  share_policy: 'exclusive',
  cost: { class: 'medium', resources: [{ id: 'cdp-port', access: 'exclusive' }] },
  actions: {
    acquire: { kind: 'slot-action', action_id: 'browser-start' },
    health: { kind: 'slot-action', action_id: 'browser-health' },
    release: { kind: 'slot-action', action_id: 'browser-stop' },
  },
  release_effects: ['stop browser'],
};

function writeProject(root: string, name: string, body: Record<string, unknown>): void {
  const dir = path.join(root, 'projects', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name, ...body }, null, 2));
}

const ROOT = makeFakeRoot();
writeProject(ROOT, 'opted-in', {
  runtime_capabilities: {
    providers: { 'browser-cdp': provider },
    host_pressure_admission: { mode: 'refuse', cpu_critical_percent: 95 },
  },
});
writeProject(ROOT, 'no-block', {
  runtime_capabilities: { providers: { 'browser-cdp': provider } },
});
// Unparseable on purpose: the loader must skip it without taking the others out.
mkdirSync(path.join(ROOT, 'projects', 'broken'), { recursive: true });
writeFileSync(path.join(ROOT, 'projects', 'broken', 'project.json'), '{ not json');

process.env.FARMSLOT_ROOT = ROOT;
const { loadProjectConfigs } = await import('./state.js');

test('loadProjectConfigs produces runtimeCapabilities, including the pressure opt-in', async () => {
  const projects = await loadProjectConfigs();
  const optedIn = projects.find((project) => project.name === 'opted-in');
  assert.ok(optedIn, 'the opted-in project loaded');
  assert.ok(
    optedIn.runtimeCapabilities?.providers['browser-cdp'],
    'providers reach ProjectConfig, not just the per-slot catalog',
  );
  assert.deepEqual(optedIn.runtimeCapabilities?.hostPressureAdmission, {
    mode: 'refuse',
    cpuCriticalPercent: 95,
  });
});

test('a project with no host_pressure_admission block leaves the field absent', async () => {
  const projects = await loadProjectConfigs();
  const plain = projects.find((project) => project.name === 'no-block');
  assert.ok(plain?.runtimeCapabilities?.providers['browser-cdp']);
  assert.equal(
    plain?.runtimeCapabilities?.hostPressureAdmission,
    undefined,
    'absent stays absent so the gateway applies its own off default',
  );
});

test('an unreadable project is skipped without dropping the readable ones', async () => {
  const projects = await loadProjectConfigs();
  assert.equal(
    projects.find((project) => project.name === 'broken'),
    undefined,
  );
  assert.deepEqual(
    projects.map((project) => project.name).sort(),
    ['no-block', 'opted-in'],
    'one bad project.json must not take the fleet down',
  );
});
