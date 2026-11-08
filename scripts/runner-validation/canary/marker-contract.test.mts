import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MARKER_TICKET, createMarkerRepo, fixtureGit, fixMarkerRepo, markerTemplateStep } from './marker-contract-fixture.mjs';

const template = `- [ ] 8. Add \`DevLogger.log('[<ticket>] BUG_MARKER: <condition>')\` and commit it alone as \`debug(<ticket>): add reproduction marker\`.
- [ ] 9. Draft buggy-behavior baseline recipe.
- [ ] 10. Recorded baseline run and visual inspection.
`;

test('mobile marker step precedes baseline drafting and recording', () => {
  assert.equal(markerTemplateStep(template), template.split('\n')[0]);
});

test('missing or changed marker contract fails instead of skipping', () => {
  for (const changed of [
    '', template.replace('8.', '7.'), template.replace('commit it alone', 'commit it'),
    template.replace('debug(<ticket>)', 'chore(<ticket>)'), template.replace('BUG_MARKER:', 'MARKER:'),
    template.replace('9.', '11.'), template.replace('Recorded baseline', 'Acceptance'),
    template.split('\n').reverse().join('\n'),
  ]) assert.throws(() => markerTemplateStep(changed), /Recipe Cook mobile step 8/);
});

test('fixture is a direct marker-only child, followed by a separate fix', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'marker-topology-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { baseSha, markerSha, patch } = await createMarkerRepo(repo);
  assert.equal(fixtureGit(repo, 'rev-parse', `${markerSha}^`), baseSha);
  assert.equal(fixtureGit(repo, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(fixtureGit(repo, 'show', '-s', '--format=%s', markerSha), `debug(${MARKER_TICKET}): add reproduction marker`);
  assert.equal(fixtureGit(repo, 'diff', '--numstat', baseSha, markerSha), '1\t0\tsource.mjs');
  assert.match(patch, /\+  DevLogger\.log\('\[MANUAL-000180\] BUG_MARKER: sum subtracts'\);/);
  assert.equal(fixtureGit(repo, 'status', '--porcelain'), '');
  const headSha = await fixMarkerRepo(repo);
  assert.equal(fixtureGit(repo, 'rev-parse', `${headSha}^`), markerSha);
  assert.equal(fixtureGit(repo, 'show', `${baseSha}:source.mjs`).includes('BUG_MARKER'), false);
  assert.equal(fixtureGit(repo, 'show', `${headSha}:source.mjs`).includes('BUG_MARKER'), false);
});
