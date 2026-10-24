import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { type FSWatcher, watch } from 'chokidar';

import {
  setTriagePilotObservationGuard,
  TRIAGE_PILOT_FILE_NAMES,
  TriagePilotObservationUnavailable,
  verifyTriagePilotEvidence,
} from '../../assessment/failure-triage/pilot-evidence.js';
import { GatewayResourceRevisions } from '../../resources/revisions.js';

import { TriagePilotObservation } from './pilot-observation.js';
import { getFailureTriage } from './service.js';

const key = { family: 'assessment', scope: 'farm' } as const;
const approved = fileURLToPath(
  new URL('../../../../../scripts/failure-triage/results/v2-held-out/', import.meta.url),
);

async function policy(home: string, directory: string) {
  await writeFile(
    path.join(home, 'triage-policy.json'),
    JSON.stringify({
      enabled: true,
      projects: ['example'],
      receiptDirectory: directory,
      maxCalls: 1,
      maxUsd: 0.01,
      price: {
        version: 1,
        provider: 'typesafe',
        model: 'jev-fixture',
        verifiedAt: new Date().toISOString(),
        source: 'fixture:observation',
        inputUsdPerMillion: 0.01,
        outputUsdPerMillion: 0,
        maxRequestTokens: 1000,
      },
      approvals: [],
    }),
  );
}

async function until(accepts: () => boolean, message: string) {
  const end = Date.now() + 2000;
  while (!accepts()) {
    assert(Date.now() < end, message);
    await delay(5);
  }
}

async function quiet(revisions: GatewayResourceRevisions) {
  let previous = revisions.revision(key);
  let stable = Date.now();
  const end = Date.now() + 1000;
  while (Date.now() - stable < 100) {
    assert(Date.now() < end, 'Source events did not settle');
    await delay(5);
    const current = revisions.revision(key);
    if (current !== previous) stable = Date.now();
    previous = current;
  }
}

test('the fixed observed receipt set exactly covers the admitted manifest', async () => {
  const manifest = JSON.parse(await readFile(path.join(approved, 'receipt-manifest.json'), 'utf8'));
  assert.deepEqual(
    [...TRIAGE_PILOT_FILE_NAMES].sort(),
    ['receipt-manifest.json', ...Object.keys(manifest.files)].sort(),
  );
  assert.equal((await verifyTriagePilotEvidence(approved)).receiptHash.length, 64);
});

test('actual admitted file edits, replacements and removal invalidate without unrelated traversal', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'triage-pilot-watch-'));
  const home = path.join(root, 'home');
  const receipts = path.join(root, 'external', 'receipts');
  await mkdir(home);
  await mkdir(receipts, { recursive: true });
  await policy(home, receipts);
  const revisions = new GatewayResourceRevisions();
  const source = new TriagePilotObservation(home, revisions);
  t.after(async () => {
    await source.close();
    revisions.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await source.refresh();
  source.assertReady(receipts);
  for (const name of TRIAGE_PILOT_FILE_NAMES) {
    const file = path.join(receipts, name);
    let before = revisions.revision(key);
    await writeFile(file, 'initial');
    await until(() => revisions.revision(key) > before, `Missing actual ${name} create`);
    before = revisions.revision(key);
    await writeFile(file + '.replacement', 'replaced');
    await rename(file + '.replacement', file);
    await until(() => revisions.revision(key) > before, `Missing actual ${name} replacement`);
  }
  let before = revisions.revision(key);
  await unlink(path.join(receipts, 'evaluation.json'));
  await until(() => revisions.revision(key) > before, 'Missing receipt removal');
  await quiet(revisions);
  before = revisions.revision(key);
  await mkdir(path.join(receipts, 'unrelated'));
  await writeFile(path.join(receipts, 'unrelated', 'evaluation.json'), 'not admitted');
  await writeFile(path.join(receipts, 'unlisted.json'), 'not admitted');
  await delay(100);
  assert.equal(revisions.revision(key), before);
  await source.close();
  await writeFile(path.join(receipts, 'report.md'), 'after close');
  await delay(60);
  assert.equal(revisions.revision(key), before, 'A closed owner cannot publish');
  assert.throws(() => source.assertReady(receipts), TriagePilotObservationUnavailable);
});

test('policy switches retire old sources, disabled/invalid policy fails closed and overlapping refreshes settle', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'triage-pilot-selection-'));
  const home = path.join(root, 'home');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await Promise.all([mkdir(home), mkdir(first), mkdir(second)]);
  await policy(home, first);
  const revisions = new GatewayResourceRevisions();
  const watchers: FSWatcher[] = [];
  const source = new TriagePilotObservation(home, revisions, (roots, options) => {
    const watcher = watch(roots, options);
    watchers.push(watcher);
    return watcher;
  });
  t.after(async () => {
    await source.close();
    revisions.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await source.refresh();
  await policy(home, second);
  await Promise.all([source.refresh(), source.refresh()]);
  source.assertReady(second);
  assert.throws(() => source.assertReady(first), TriagePilotObservationUnavailable);
  assert(watchers.slice(0, -1).every((watcher) => watcher.closed));
  await quiet(revisions);
  const before = revisions.revision(key);
  await writeFile(path.join(first, 'evaluation.json'), 'retired');
  await delay(100);
  assert.equal(revisions.revision(key), before);
  await writeFile(path.join(home, 'triage-policy.json'), '{broken');
  await source.refresh();
  assert.throws(() => source.assertReady(second), TriagePilotObservationUnavailable);
  assert(watchers.every((watcher) => watcher.closed));
  await writeFile(path.join(home, 'triage-policy.json'), '{"enabled":false}');
  await source.refresh();
  assert.throws(() => source.assertReady(second), TriagePilotObservationUnavailable);
  await policy(home, second);
  await source.refresh();
  source.assertReady(second);
});

test('missing/replaced directories and symlink targets recover under bounded parent ownership', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'triage-pilot-topology-'));
  const home = path.join(root, 'home');
  const selected = path.join(root, 'later', 'receipts');
  await mkdir(home);
  await policy(home, selected);
  const revisions = new GatewayResourceRevisions();
  const source = new TriagePilotObservation(home, revisions);
  t.after(async () => {
    await source.close();
    revisions.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await source.refresh();
  source.assertReady(selected); // Observed absence still makes the real verifier unavailable.
  await mkdir(selected, { recursive: true });
  await until(() => {
    try {
      source.assertReady(selected);
      return true;
    } catch (error) {
      if (!(error instanceof TriagePilotObservationUnavailable)) throw error;
      return false;
    }
  }, 'A new selected directory must become observed');
  await rename(selected, selected + '-old');
  await mkdir(selected);
  await until(() => {
    try {
      source.assertReady(selected);
      return true;
    } catch (error) {
      if (!(error instanceof TriagePilotObservationUnavailable)) throw error;
      return false;
    }
  }, 'A replacement directory must become observed');
  const other = path.join(root, 'other');
  const alias = path.join(root, 'alias');
  await mkdir(other);
  await symlink(selected, alias, 'dir');
  await policy(home, alias);
  await source.refresh();
  source.assertReady(alias);
  await unlink(alias);
  await symlink(other, alias, 'dir');
  await until(() => {
    try {
      source.assertReady(alias);
      return true;
    } catch (error) {
      if (!(error instanceof TriagePilotObservationUnavailable)) throw error;
      return false;
    }
  }, 'A changed symlink target must become observed');
  const before = revisions.revision(key);
  await writeFile(path.join(other, 'evaluation.json'), 'new selected target');
  await until(() => revisions.revision(key) > before, 'The new physical target must publish');
});

test('observation failure and unexpected close refuse readiness instead of returning fresh data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'triage-pilot-failure-'));
  const home = path.join(root, 'home');
  const receipts = path.join(root, 'receipts');
  await Promise.all([mkdir(home), mkdir(receipts)]);
  await policy(home, receipts);
  const revisions = new GatewayResourceRevisions();
  let watcher!: FSWatcher;
  const source = new TriagePilotObservation(home, revisions, (roots, options) => {
    watcher = watch(roots, options);
    return watcher;
  });
  t.after(async () => {
    await source.close();
    revisions.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await source.refresh();
  const before = revisions.revision(key);
  watcher.emit('error', new Error('lost source descriptor'));
  assert(revisions.revision(key) > before);
  assert.throws(() => source.assertReady(receipts), TriagePilotObservationUnavailable);
  await source.refresh();
  source.assertReady(receipts);
  await watcher.close();
  assert.throws(() => source.assertReady(receipts), TriagePilotObservationUnavailable);
});

test('an admitted artifact symlink observes its physical source and a replacement target', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'triage-pilot-file-link-'));
  const home = path.join(root, 'home');
  const receipts = path.join(root, 'receipts');
  const other = path.join(root, 'outside');
  await Promise.all([mkdir(home), mkdir(receipts), mkdir(other)]);
  const first = path.join(other, 'first.json');
  const second = path.join(other, 'second.json');
  await Promise.all([writeFile(first, 'first'), writeFile(second, 'second')]);
  const link = path.join(receipts, 'evaluation.json');
  await symlink(first, link);
  await policy(home, receipts);
  const revisions = new GatewayResourceRevisions();
  const source = new TriagePilotObservation(home, revisions);
  t.after(async () => {
    await source.close();
    revisions.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await source.refresh();
  source.assertReady(receipts);
  await quiet(revisions);
  let before = revisions.revision(key);
  await writeFile(first, 'changed physical bytes');
  await until(
    () => revisions.revision(key) > before,
    'The admitted file symlink must observe its target',
  );
  await unlink(link);
  await symlink(second, link);
  await until(() => {
    try {
      source.assertReady(receipts);
      return true;
    } catch (error) {
      if (!(error instanceof TriagePilotObservationUnavailable)) throw error;
      return false;
    }
  }, 'The artifact link replacement must rebind');
  await quiet(revisions);
  before = revisions.revision(key);
  await writeFile(second, 'changed replacement target');
  await until(
    () => revisions.revision(key) > before,
    'The replacement artifact target must publish',
  );
  const later = path.join(other, 'later.json');
  await unlink(link);
  await symlink(later, link);
  await source.refresh();
  await quiet(revisions);
  before = revisions.revision(key);
  await writeFile(later, 'newly readable linked source');
  await until(
    () => revisions.revision(key) > before,
    'A newly readable admitted symlink target must publish',
  );
});

test('the real triage getter propagates observation failure instead of a fresh unavailable view', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'triage-pilot-admission-'));
  const variables = [
    'FARMSLOT_HOME',
    'FARMSLOT_ASSESSMENT_ENABLED',
    'FARMSLOT_ASSESSMENT_PROVIDER',
    'FARMSLOT_ASSESSMENT_MODEL',
  ];
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  process.env.FARMSLOT_HOME = root;
  process.env.FARMSLOT_ASSESSMENT_ENABLED = 'true';
  process.env.FARMSLOT_ASSESSMENT_PROVIDER = 'typesafe';
  process.env.FARMSLOT_ASSESSMENT_MODEL = 'jev-1.13.0';
  await policy(root, approved);
  setTriagePilotObservationGuard(() => {
    throw new TriagePilotObservationUnavailable();
  });
  t.after(async () => {
    setTriagePilotObservationGuard(() => undefined);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    getFailureTriage('observation-test', { runId: '00000000-0000-0000-0000-000000000001' }),
    TriagePilotObservationUnavailable,
  );
});
