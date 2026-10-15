import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRecipeCliJsonFileWithinRoot } from '../src/cli/support.js';
import { digestFileWithinRoot, statFileWithinRoot } from '../src/core/path.js';
import { readRecordedEvidencePackage } from '../src/evidence/read-package.js';

const fdCount = () =>
  readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').filter((name) =>
    /^\d+$/.test(name),
  ).length;

test(
  'repeated concurrent evidence reads keep descriptors bounded and return them before completion',
  { skip: !['darwin', 'linux'].includes(process.platform) },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-fds-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(
      new URL(
        '../../../docs/examples/recipes/farmslot/artifacts/provenance-smoke/',
        import.meta.url,
      ),
      root,
      { recursive: true },
    );
    const manifest = JSON.parse(await readFile(path.join(root, 'artifact-manifest.json'), 'utf8'));
    const payload = JSON.stringify({ data: 'evidence'.repeat(4096) });
    const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    for (let i = 0; i < 40; i++) {
      const file = `evidence-${i}.json`;
      await writeFile(path.join(root, file), payload);
      manifest.artifacts.push({
        path: file,
        type: 'json',
        label: `Evidence ${i}`,
        mimeType: 'application/json',
      });
    }
    await writeFile(path.join(root, 'artifact-manifest.json'), JSON.stringify(manifest));
    const before = fdCount();
    let peak = before;
    const samples: number[] = [];
    const timer = setInterval(() => {
      peak = Math.max(peak, fdCount());
    }, 1);
    try {
      for (let round = 0; round < 3; round++) {
        const reads = await Promise.all(
          Array.from({ length: 8 }, () => readRecordedEvidencePackage(root)),
        );
        for (const read of reads) {
          assert.ok(read.checks.every((check) => check.status === 'pass'));
          assert.equal(read.input.artifactDigests['evidence-0.json'], digest);
        }
        samples.push(fdCount());
        assert.ok(samples.at(-1)! <= before + 2, `settled reads leaked descriptors: ${samples}`);
      }
    } finally {
      clearInterval(timer);
    }
    t.diagnostic(JSON.stringify({ before, peak, settled: samples }));
    assert.ok(peak <= before + 16, `unbounded descriptor fanout: baseline=${before}, peak=${peak}`);
    await writeFile(path.join(root, 'evidence-0.json'), '{"data":"changed"}');
    assert.notEqual(
      (await readRecordedEvidencePackage(root)).input.artifactDigests['evidence-0.json'],
      digest,
    );
  },
);

test(
  'failed evidence reads close descriptors and release capacity for later reads',
  { skip: !['darwin', 'linux'].includes(process.platform) },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-fd-errors-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'bad.json'), '{');
    const before = fdCount();
    const failed = await Promise.allSettled(
      Array.from({ length: 32 }, (_, i) =>
        i % 2
          ? digestFileWithinRoot(root, 'missing')
          : readRecipeCliJsonFileWithinRoot(root, 'bad.json'),
      ),
    );
    assert.ok(failed.every((result) => result.status === 'rejected'));
    await writeFile(path.join(root, 'good.json'), '{}');
    assert.equal((await statFileWithinRoot(root, 'good.json')).size, 2);
    assert.equal(
      await digestFileWithinRoot(root, 'good.json'),
      `sha256:${createHash('sha256').update('{}').digest('hex')}`,
    );
    assert.ok(fdCount() <= before + 2);
  },
);
