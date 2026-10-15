import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  readSourceRuntimeSettings,
  writeSourceRuntimeSettings,
} from './source-runtime-settings.js';

test('mutable project policy retains backups in a farm root without writing source files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-policy-test-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  try {
    const source = path.join(root, 'sealed-source');
    await mkdir(source);
    const bytes = '{"name":"demo","backlog":{"auto_dispatch":{"enabled":false}}}';
    await writeFile(path.join(source, 'project.json'), bytes);
    const firstBackup = await writeSourceRuntimeSettings('demo', {
      backlog: { auto_dispatch: { enabled: true } },
    });
    assert.deepEqual(JSON.parse(await readFile(firstBackup, 'utf8')).values, {});
    const secondBackup = await writeSourceRuntimeSettings('demo', {
      auto_recovery: { enabled: false },
    });
    assert.equal(
      JSON.parse(await readFile(secondBackup, 'utf8')).values.backlog.auto_dispatch.enabled,
      true,
    );
    assert.deepEqual(await readSourceRuntimeSettings('demo'), {
      backlog: { auto_dispatch: { enabled: true } },
      auto_recovery: { enabled: false },
    });
    assert.equal(await readFile(path.join(source, 'project.json'), 'utf8'), bytes);
    const delegation = {
      delegatedReviewerPrincipalIds: ['lead'],
      delegatorPrincipalId: 'person',
      personOnlyClaimIds: ['ac1'],
    };
    await writeSourceRuntimeSettings('demo', { visual_claim_review: delegation });
    assert.deepEqual((await readSourceRuntimeSettings('demo')).visual_claim_review, {
      ...delegation,
      personOnlyClaimIds: ['AC-1'],
    });
    assert.equal(await readFile(path.join(source, 'project.json'), 'utf8'), bytes);
    await assert.rejects(
      writeSourceRuntimeSettings('demo', { visual_claim_review: { delegatorPrincipalId: '' } }),
      /Invalid project visualClaimReview/,
    );
    await assert.rejects(writeSourceRuntimeSettings('../escape', {}), /Invalid/);
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
