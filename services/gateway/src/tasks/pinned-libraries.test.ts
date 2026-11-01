import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pinnedTaskLibraries } from './pinned-libraries.js';

test('a bound task pins the libraries its binding names inside its task pin', (t) => {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'pinned-libraries-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  assert.deepEqual([...pinnedTaskLibraries(taskDir)], [], 'an unbound task pins none');
  const pin = '/home/.farmslot/task-pins/ba9f77';
  mkdirSync(path.join(taskDir, 'artifacts'));
  writeFileSync(
    path.join(taskDir, 'artifacts/harness-provenance.json'),
    JSON.stringify({
      pin,
      bindingIdentity: {
        libraries: [
          { name: 'perps', path: `${pin}/inputs/39/recipe-perps` },
          // Bound before pinning, or bundled with the provider: not a pinned copy.
          { name: 'metamask', path: '/home/.local/share/metamask-harness/library' },
          { name: 'sibling', path: `${pin}-other/inputs/2/x` },
        ],
      },
    }),
  );
  assert.deepEqual([...pinnedTaskLibraries(taskDir)], [['perps', `${pin}/inputs/39/recipe-perps`]]);
});
