// project-config-load.test.ts — the loader must actually PRODUCE every field
// ProjectConfig declares.
//
// `runtimeCapabilities` was declared on the contract and read by host-pressure
// admission while nothing ever assigned it, so a project's opt-in was silently
// unreachable. A type that nothing produces typechecks perfectly, so this is a
// behavioural test against a real project.json on disk.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

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
after(() => rmSync(ROOT, { recursive: true, force: true }));
writeProject(ROOT, 'opted-in', {
  visual_claim_review: {
    delegatedReviewerPrincipalIds: ['lead-reviewer'],
    delegatorPrincipalId: 'person',
  },
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
  assert.deepEqual(optedIn.visualClaimReview, {
    delegatedReviewerPrincipalIds: ['lead-reviewer'],
    delegatorPrincipalId: 'person',
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
  assert.equal(plain?.visualClaimReview, undefined);
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

test('a pack-copied project takes delegation and policy edits from runtime settings only', async (t) => {
  // `farmslot update` replaces a pack-copied project.json, and the pack ships it: its delegation
  // is not an operator grant, exactly as for a source-bound project.
  writeProject(ROOT, 'pack-copied', {
    visual_claim_review: { delegatedReviewerPrincipalIds: ['pack-reviewer'] },
    backlog: { auto_dispatch: { enabled: false } },
  });
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-pack-home-'));
  const state = path.join(home, 'state.json');
  writeFileSync(state, JSON.stringify({ packs: { pack: { projects: ['pack-copied'] } } }));
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  const { __setWorkspaceStatePathForTest, writeSourceRuntimeSettings } =
    await import('../core/config.js');
  __setWorkspaceStatePathForTest(state);
  t.after(() => {
    __setWorkspaceStatePathForTest();
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(path.join(ROOT, 'projects', 'pack-copied'), { recursive: true, force: true });
  });
  await writeSourceRuntimeSettings('pack-copied', {
    backlog: { auto_dispatch: { enabled: true } },
  });

  const copied = (await loadProjectConfigs()).find((project) => project.name === 'pack-copied');
  assert.equal(copied?.backlog?.autoDispatch?.enabled, true);
  assert.equal(copied?.visualClaimReview, undefined);
});
