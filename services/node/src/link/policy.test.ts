import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { configuredNodeLinkEnabled, NODE_LINK_FLAG } from '@farmslot/protocol/node/slot-by-repo';

test('pilot defaults off and remains configured while its socket is absent', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(configuredNodeLinkEnabled('fixture', root), false);
  await writeFile(path.join(root, 'fixture.json'), JSON.stringify({ machine: 'fixture', env: {} }));
  assert.equal(configuredNodeLinkEnabled('fixture', root), false);
  await writeFile(
    path.join(root, 'fixture.json'),
    JSON.stringify({ machine: 'fixture', env: { [NODE_LINK_FLAG]: '1' } }),
  );
  assert.equal(configuredNodeLinkEnabled('fixture', root), true);
  // No connection registry participates in this decision, so disconnect cannot enable SSH.
  assert.equal(configuredNodeLinkEnabled('fixture', root), true);
  assert.throws(() => configuredNodeLinkEnabled('../other', root), /identity/);
});
