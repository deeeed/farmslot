import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { linkCheckout } from '../../../../scripts/runner-validation/lib/isolated-stack.mjs';

test(
  'an isolated checkout bundles scripts and still refuses an escaping support path',
  { timeout: 5000 },
  async (t) => {
    const temp = await mkdtemp('/tmp/f416-checkout-');
    t.after(() => rm(temp, { recursive: true, force: true }));
    const source = path.join(temp, 'source');
    const fixture = path.join(temp, 'fixture');
    await mkdir(path.join(source, 'scripts'), { recursive: true });
    await writeFile(path.join(source, 'scripts/write-runtime-context.sh'), '#!/bin/sh\n');
    await writeFile(path.join(source, 'scripts/dev.sh'), '#!/bin/sh\n');
    await mkdir(path.join(source, 'services/gateway'), { recursive: true });
    await writeFile(path.join(source, 'services/gateway/package.json'), '{}');
    execFileSync('git', ['init', '-q', source]);
    await linkCheckout(source, fixture, 'Support fixture', { packageManager: false });
    const project = path.join(fixture, 'projects', 'fixture');
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, 'project.json'),
      JSON.stringify({
        qa: {
          default_profile: 'smoke',
          profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
        },
      }),
    );
    process.env.FARMSLOT_ROOT = fixture;
    process.env.FARMSLOT_PROJECTS_DIR = path.join(fixture, 'projects');
    process.env.FARMSLOT_POOL_DIR = path.join(fixture, 'pool');
    const { collectNodeSupportBundle } = await import('./ensure.js');
    const bundle = await collectNodeSupportBundle('fixture', ['scripts/write-runtime-context.sh']);
    assert.equal(bundle.files.length, 1);
    assert.equal(
      Buffer.from(bundle.files[0]!.contentBase64, 'base64').toString(),
      await readFile(path.join(source, 'scripts/write-runtime-context.sh'), 'utf8'),
    );
    await symlink(source, path.join(fixture, 'escape'));
    await assert.rejects(
      collectNodeSupportBundle('fixture', ['escape/scripts/write-runtime-context.sh']),
      /Node support path escapes Farmslot root/,
    );
  },
);
