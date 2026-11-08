import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isTicketMarkerCommit } from '../../../services/gateway/src/run-completion/baseline-debug-marker.js';
import { MARKER_TICKET, createMarkerRepo, fixtureGit, fixMarkerRepo, markerTemplateStep } from './marker-contract-fixture.mjs';
import { runMarkerContract } from './marker-contract.mjs';

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
    template.replace("`DevLogger.log('[<ticket>] BUG_MARKER: <condition>')`", '[<ticket>] BUG_MARKER: <condition>'),
  ]) assert.throws(() => markerTemplateStep(changed), /Recipe Cook mobile step 8/);
});

test('fixture is a direct marker-only child, followed by a separate fix', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'marker-topology-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { baseSha, markerSha, patch } = await createMarkerRepo(repo, markerTemplateStep(template));
  assert.equal(fixtureGit(repo, 'rev-parse', `${markerSha}^`), baseSha);
  assert.equal(fixtureGit(repo, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(fixtureGit(repo, 'show', '-s', '--format=%s', markerSha), `debug(${MARKER_TICKET}): add reproduction marker`);
  assert.equal(fixtureGit(repo, 'diff', '--numstat', baseSha, markerSha), '1\t0\tsource.mjs');
  assert.match(patch, /\+  DevLogger\.log\('\[MANUAL-000180\] BUG_MARKER: sum subtracts'\)$/);
  assert.equal(await isTicketMarkerCommit(patch, baseSha, markerSha, MARKER_TICKET), true);
  assert.equal(fixtureGit(repo, 'status', '--porcelain'), '');
  const headSha = await fixMarkerRepo(repo);
  assert.equal(fixtureGit(repo, 'rev-parse', `${headSha}^`), markerSha);
  assert.equal(fixtureGit(repo, 'show', `${baseSha}:source.mjs`).includes('BUG_MARKER'), false);
  assert.equal(fixtureGit(repo, 'show', `${headSha}:source.mjs`).includes('BUG_MARKER'), false);
});

test('console.log prescribed by the template reaches the gateway and is refused', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'marker-console-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const changed = template.replace('DevLogger.log', 'console.log');
  const cook = path.join(dir, 'cook');
  const { baseSha, markerSha, patch } = await createMarkerRepo(cook, markerTemplateStep(changed));
  assert.match(patch, /\+  console\.log\('\[MANUAL-000180\] BUG_MARKER: sum subtracts'\)$/);
  assert.equal(await isTicketMarkerCommit(patch, baseSha, markerSha, MARKER_TICKET), false);
  const templates = path.join(cook, 'references/templates/fix-bug');
  await mkdir(templates, { recursive: true });
  await writeFile(path.join(templates, 'mobile.md'), changed);
  const previous = process.env.CONSENSYS_RECIPE_COOK_ROOT;
  process.env.CONSENSYS_RECIPE_COOK_ROOT = cook;
  t.after(() => {
    if (previous === undefined) delete process.env.CONSENSYS_RECIPE_COOK_ROOT;
    else process.env.CONSENSYS_RECIPE_COOK_ROOT = previous;
  });
  const check = await runMarkerContract(path.join(dir, 'evidence'));
  const fixture = JSON.parse(await readFile(path.join(check.evidence!, 'fixture.json'), 'utf8'));
  assert.match(fixture.patch, /\+  console\.log\(/);
  assert.equal(await isTicketMarkerCommit(fixture.patch, fixture.baseSha, fixture.markerSha, MARKER_TICKET), false);
  assert.equal(check.status, 'fail');
  assert.match(check.error!, /Before evidence .*not the unchanged base/);
  assert.equal(JSON.parse(await readFile(path.join(check.evidence!, 'check.json'), 'utf8')).error, check.error);
});
