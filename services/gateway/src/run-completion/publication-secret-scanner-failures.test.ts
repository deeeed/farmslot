import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';

import type { PublicationScanRequest } from './publication-secret-scan-worker.js';

/** Stands in for the scan worker so each failure can be driven deterministically. */
class FakeWorker extends EventEmitter {
  readonly posted: PublicationScanRequest[] = [];
  terminated = false;

  constructor() {
    super();
    workers.push(this);
  }

  postMessage(request: PublicationScanRequest): void {
    this.posted.push(request);
  }

  ref(): void {}

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminated = true;
    this.emit('exit', 1);
    return 1;
  }

  /** Answers one posted request, the latest by default. */
  reply(
    reply: { hits?: { kind: string; fingerprint: string }[]; error?: string },
    request = this.posted.at(-1),
  ): void {
    assert.ok(request, 'no scan was posted');
    this.emit('message', { id: request.id, ...reply });
  }
}

const workers: FakeWorker[] = [];
mock.module('node:worker_threads', { namedExports: { Worker: FakeWorker } });
const {
  assertPublicationTextSafe,
  MAX_PENDING_PUBLICATION_SCANS,
  PublicationSecretError,
  stopPublicationSecretScanner,
} = await import('./publication-secrets.js');

function latest(): FakeWorker {
  const worker = workers.at(-1);
  assert.ok(worker, 'no scan worker was started');
  return worker;
}

// A scan that never settles is the failure these tests guard against.
const settles = { timeout: 5_000 };

const notASecretRefusal = (pattern: RegExp) => (error: unknown) =>
  error instanceof Error &&
  !(error instanceof PublicationSecretError) &&
  pattern.test(error.message);

test(
  'a crashed scanner refuses waiting scans and the next scan starts a new one',
  settles,
  async () => {
    const pending = assertPublicationTextSafe('text');
    const crashed = latest();
    crashed.emit('error', new Error('scanner crashed'));
    await assert.rejects(pending, notASecretRefusal(/scanner crashed/));
    const next = assertPublicationTextSafe('text');
    assert.notEqual(latest(), crashed);
    latest().reply({ hits: [] });
    await next;
  },
);

test('a scanner that exits before replying refuses the waiting scan', settles, async () => {
  const pending = assertPublicationTextSafe('text');
  latest().emit('exit', 1);
  await assert.rejects(pending, notASecretRefusal(/exited with code 1/));
});

test('a scan the worker could not complete refuses', settles, async () => {
  const pending = assertPublicationTextSafe('text');
  latest().reply({ error: 'detector failed' });
  await assert.rejects(pending, notASecretRefusal(/scan failed: detector failed/));
});

test('detected secret values refuse with fingerprints', settles, async () => {
  const pending = assertPublicationTextSafe('text');
  latest().reply({ hits: [{ kind: 'private-key', fingerprint: 'sha256:0123456789ab' }] });
  await assert.rejects(pending, PublicationSecretError);
});

test('a saturated scanner refuses instead of queueing without bound', settles, async () => {
  const waiting = Array.from({ length: MAX_PENDING_PUBLICATION_SCANS }, () =>
    assertPublicationTextSafe('text'),
  );
  await assert.rejects(assertPublicationTextSafe('text'), notASecretRefusal(/saturated/));
  const worker = latest();
  for (const request of worker.posted) worker.reply({ hits: [] }, request);
  await Promise.all(waiting);
});

test('shutdown terminates the scanner and refuses waiting scans', settles, async () => {
  const refused = assert.rejects(assertPublicationTextSafe('text'), notASecretRefusal(/stopped/));
  const worker = latest();
  await stopPublicationSecretScanner();
  assert.equal(worker.terminated, true);
  await refused;
});
