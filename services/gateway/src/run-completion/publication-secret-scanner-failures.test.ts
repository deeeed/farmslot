import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';

import type { PublicationScanRequest } from '../host-services/secret-scan-protocol.js';

/** Stands in for the forked scan process so each failure can be driven deterministically. */
class FakeScanProcess extends EventEmitter {
  readonly posted: PublicationScanRequest[] = [];
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  terminated = false;
  readonly channel = { ref() {}, unref() {} };

  constructor() {
    super();
    workers.push(this);
  }

  send(request: PublicationScanRequest, callback?: (error: Error | null) => void): boolean {
    this.posted.push(request);
    callback?.(null);
    return true;
  }

  ref(): void {}

  unref(): void {}

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.terminated = true;
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
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

const workers: FakeScanProcess[] = [];
const realChildProcess = await import('node:child_process');
const fork = () => new FakeScanProcess();
// Node 22 cannot mock a module whose named exports include `default`: it goes in defaultExport.
const { default: realChildProcessDefault, ...realChildProcessNamed } = realChildProcess;
mock.module('node:child_process', {
  namedExports: { ...realChildProcessNamed, fork },
  defaultExport: { ...realChildProcessDefault, fork },
});
const { default: secretScan, MAX_PENDING_PUBLICATION_SCANS } =
  await import('../host-services/secret-scan.js');
const { assertPublicationTextSafe, PublicationSecretError } =
  await import('./publication-secrets.js');

function latest(): FakeScanProcess {
  const worker = workers.at(-1);
  assert.ok(worker, 'no scan process was started');
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
  await secretScan.stop();
  assert.equal(worker.terminated, true);
  await refused;
});
