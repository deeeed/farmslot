import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { PendingDecision } from '@farmslot/protocol';

import type { BackgroundHost } from '../host-services/background/client.js';
import type { BackgroundResult } from '../host-services/background/protocol.js';

// The monitor's decision walk comes from the background host. No decision file exists on disk,
// so every decision a reader sees came through the host.
const projects = mkdtempSync(path.join(tmpdir(), 'fleet-monitor-background-'));
after(() => rmSync(projects, { recursive: true, force: true }));
process.env.FARMSLOT_PROJECTS_DIR = projects;
const realFiles = await import('node:fs/promises');
// The monitor persists its state on stop; keep that out of the checkout.
mock.module('node:fs/promises', { namedExports: { ...realFiles, writeFile: async () => {} } });

const client = await import('../host-services/background/client.js');
let walk: () => Promise<BackgroundResult<'decisions.scan'>> = async () => [];
let walks = 0;
const fakeHost: BackgroundHost = {
  active: () => true,
  async request(operation) {
    assert.equal(operation, 'decisions.scan');
    walks++;
    // The fake serves only the scan operation, whose result type this is.
    return (await walk()) as never;
  },
  start() {},
  stop: async () => {},
  status: () => client.backgroundHost.status(),
};
mock.module('../host-services/background/client.js', {
  namedExports: { ...client, backgroundHost: fakeHost },
});
await import('../runtime/mock-pty.test-support.js');
const { loadPendingDecisions, resolveFileDecision, scanDecisions, startMonitor, stopMonitor } =
  await import('./fleet-monitor.js');

const decision: PendingDecision = {
  id: 'from-background',
  type: 'plan_confirmation',
  slotId: 'slot-1',
  title: 'Choose',
  description: 'Pick one',
  context: {},
  actions: [],
  createdAt: '2026-11-11T00:00:00Z',
};

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

test('a listing before any monitor result walks through the background host', async () => {
  walk = async () => [{ path: '/tasks/run/.pending_decision.json', decision, signature: 'one' }];
  const before = walks;
  assert.deepEqual(
    (await loadPendingDecisions()).map(({ id }) => id),
    ['from-background'],
  );
  assert.equal(walks, before + 1);
});

test('resolving a file decision finds its file through the background host', async () => {
  // The file lives outside the projects dir: only the host's answer can lead the resolver to it.
  const file = path.join(projects, '..', `${path.basename(projects)}-decision.json`);
  writeFileSync(file, '{}');
  after(() => rmSync(file, { force: true }));
  walk = async () => [
    {
      path: file,
      decision: { ...decision, actions: [{ id: 'ack', label: 'Ack', style: 'primary' }] },
      signature: 'one',
    },
  ];
  const before = walks;
  await resolveFileDecision('from-background', 'ack');
  assert.equal(walks, before + 1);
  assert.equal(existsSync(file), false);
});

test('while the background host is down, listing and resolving fail closed', async () => {
  walk = async () => {
    throw new client.BackgroundUnavailableError('The gateway background process is restarting');
  };
  await assert.rejects(loadPendingDecisions(), client.BackgroundUnavailableError);
  await assert.rejects(
    resolveFileDecision('from-background', 'ack'),
    client.BackgroundUnavailableError,
  );
});

test('the monitor announces decisions the background walk found', async (t) => {
  walk = async () => [{ path: '/tasks/run/.pending_decision.json', decision, signature: 'one' }];
  const announced: PendingDecision[] = [];
  t.after(stopMonitor);
  startMonitor({
    onPublicationGateStall() {},
    onFleetUpdated() {},
    onDecisionNew: (found) => announced.push(found),
    onViolation() {},
  });
  await until(() => announced.length > 0);
  assert.deepEqual(
    announced.map(({ id }) => id),
    ['from-background'],
  );
  assert.deepEqual(
    (await loadPendingDecisions()).map(({ id }) => id),
    ['from-background'],
  );

  // A host outage is not a decision read failure: readers keep the last scan.
  const before = walks;
  walk = async () => {
    throw new client.BackgroundUnavailableError('The gateway background process is restarting');
  };
  await assert.rejects(scanDecisions(), client.BackgroundUnavailableError);
  assert.equal(walks, before + 1);
  assert.deepEqual(
    (await loadPendingDecisions()).map(({ id }) => id),
    ['from-background'],
  );

  // A walk that failed in the child is a real read failure, which readers see.
  walk = async () => {
    throw new client.BackgroundRequestError('decisions.scan', 'Error', 'EACCES: projects');
  };
  await assert.rejects(scanDecisions(), /EACCES: projects/);
  await assert.rejects(loadPendingDecisions(), /EACCES: projects/);
});
