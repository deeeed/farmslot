import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

// stat fails for links with whichever code the test sets; everything else is real.
let linkError = '';
const realFs = await import('node:fs/promises');
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    stat: async (target: string) => {
      if (path.basename(target) === 'linked' && linkError)
        throw Object.assign(new Error(`stat failed: ${linkError}`), { code: linkError });
      return realFs.stat(target);
    },
  },
});
const { listProjectTaskRoots } = await import('../../src/node/farm-layout.js');

const farm = mkdtempSync(path.join(tmpdir(), 'farm-layout-link-errors-'));
after(() => rmSync(farm, { recursive: true, force: true }));
const projectsDir = path.join(farm, 'projects');
mkdirSync(path.join(projectsDir, 'app'), { recursive: true });
mkdirSync(path.join(farm, 'target'));
symlinkSync(path.join(farm, 'target'), path.join(projectsDir, 'linked'));
const layout = { farmslotRoot: farm, projectsDir };

test('a link that does not resolve is skipped', async () => {
  for (const code of ['ENOENT', 'ELOOP', 'EACCES', 'EPERM', 'ENOTDIR']) {
    linkError = code;
    const roots = await listProjectTaskRoots(layout);
    assert.deepEqual(
      roots.map((root) => root.project),
      ['app'],
      code,
    );
  }
});

test('any other link failure is a failing read and is rethrown', async () => {
  for (const code of ['EIO', 'EMFILE']) {
    linkError = code;
    await assert.rejects(listProjectTaskRoots(layout), { code });
  }
});
