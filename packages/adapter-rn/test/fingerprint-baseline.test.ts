import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  checkFingerprintBaseline,
  recordFingerprintBaseline,
} from '../src/fingerprint-baseline.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fp-baseline-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('fingerprint baseline', () => {
  it('returns missing when no marker exists', async () => {
    const dir = await tempDir();
    const markerPath = path.join(dir, 'baseline.json');
    const result = checkFingerprintBaseline(markerPath, 'abc123');
    assert.deepEqual(result, { fingerprint: 'abc123', status: 'missing' });
  });

  it('returns current when the recorded fingerprint matches', async () => {
    const dir = await tempDir();
    const markerPath = path.join(dir, 'baseline.json');
    const fp = 'deadbeef';
    const recorded = recordFingerprintBaseline(markerPath, fp, () => fp);
    assert.ok(recorded, 'should have recorded baseline');

    const result = checkFingerprintBaseline(markerPath, fp);
    assert.deepEqual(result, { fingerprint: fp, status: 'current' });
  });

  it('returns changed when the recorded fingerprint differs', async () => {
    const dir = await tempDir();
    const markerPath = path.join(dir, 'baseline.json');
    const fp = 'aaa111';
    const recorded = recordFingerprintBaseline(markerPath, fp, () => fp);
    assert.ok(recorded);

    const result = checkFingerprintBaseline(markerPath, 'bbb222');
    assert.deepEqual(result, { fingerprint: 'bbb222', status: 'changed' });
  });

  it('returns missing for a corrupt JSON marker', async () => {
    const dir = await tempDir();
    const markerPath = path.join(dir, 'baseline.json');
    await writeFile(markerPath, '{not valid json');

    const result = checkFingerprintBaseline(markerPath, 'xyz');
    assert.deepEqual(result, { fingerprint: 'xyz', status: 'missing' });
  });

  it('records only while the fingerprint is stable; a drift during the record removes the marker', async () => {
    const dir = await tempDir();
    const markerPath = path.join(dir, 'baseline.json');
    const fp = 'stable';

    // First call: drift detected before the write — should not record.
    let callCount = 0;
    const driftImmediately = () => {
      callCount += 1;
      // First check: matches. Second check (inside recordFingerprintBaseline): drifts.
      return callCount === 1 ? fp : 'drifted';
    };
    const recorded = recordFingerprintBaseline(markerPath, fp, driftImmediately);
    assert.ok(!recorded, 'should not record when fingerprint drifts');
    assert.ok(!fs.existsSync(markerPath), 'no baseline file should exist after drift');

    // Normal case: stable fingerprint records successfully.
    const stableRecorded = recordFingerprintBaseline(markerPath, fp, () => fp);
    assert.ok(stableRecorded, 'should record when fingerprint is stable');
    assert.ok(fs.existsSync(markerPath));
  });
});
