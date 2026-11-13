import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  executionTemplateSourceDirty as dirtySync,
  executionTemplateSourceRevision as revisionSync,
} from '@farmslot/agent-runtime';
import { NativeProcessTree } from '@farmslot/agent-runtime/native/process-tree';

import { gatewayPerformance } from '../observability/performance.js';

import {
  executionTemplateSourceDirty,
  executionTemplateSourceRevision,
} from './execution-template-sources.js';
import { withMeasuredNativeProcessCensus } from './native-process.js';

function count(operation: string): number {
  return gatewayPerformance
    .snapshot()
    .counters.filter(
      (row) =>
        row.name === 'farmslot_exec_calls_total' && row.labels.method === `host:${operation}`,
    )
    .reduce((sum, row) => sum + row.value, 0);
}

test('native launch census preserves identities and records its managed exec', async () => {
  const expected = new NativeProcessTree(process.pid, { gated: true }).snapshot();
  const before = count('nativeProcess.census');
  const tree = await withMeasuredNativeProcessCensus(() =>
    NativeProcessTree.create(process.pid, { gated: true }),
  );
  assert.deepEqual(tree.snapshot(), expected);
  assert.equal(count('nativeProcess.census') - before, 1);
});

for (const mode of ['normal', 'stderr', 'overflow', 'failed', 'absent'] as const) {
  test(`source provenance matches the sync driver for ${mode} git and records both reads`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'source-git-fixture-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    if (mode !== 'absent')
      writeFileSync(
        path.join(root, 'git'),
        `#!${process.execPath}
if (${JSON.stringify(mode)} === 'failed') process.exit(17);
if (${JSON.stringify(mode)} === 'stderr') process.stderr.write('e'.repeat(2*1024*1024));
const out = ${JSON.stringify(mode)} === 'overflow' ? 'x'.repeat(2*1024*1024) : process.argv.includes('rev-parse') ? 'a'.repeat(40)+'\\n' : '?? fixture\\n';
process.stdout.write(out);
`,
        { mode: 0o755 },
      );
    const previousPath = process.env.PATH;
    process.env.PATH = root;
    try {
      const revision = revisionSync(root);
      const dirty = dirtySync(root);
      const before = count('executionTemplate.sources');
      assert.equal(await executionTemplateSourceRevision(root), revision);
      assert.equal(await executionTemplateSourceDirty(root), dirty);
      assert.equal(count('executionTemplate.sources') - before, 2);
      if (mode === 'normal' || mode === 'stderr') {
        assert.equal(revision, 'a'.repeat(40));
        assert.equal(dirty, true);
      } else {
        assert.equal(revision, undefined);
        assert.equal(dirty, undefined);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
}
