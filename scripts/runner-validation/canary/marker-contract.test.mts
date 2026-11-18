import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { isTicketMarkerCommit } from '../../../services/gateway/src/run-completion/baseline-debug-marker.js';
import {
  MARKER_TICKET,
  createMarkerRepo,
  fixtureGit,
  fixMarkerRepo,
  markerTemplateStep,
  recordMarkerEvidence,
} from './marker-contract-fixture.mjs';
import { runMarkerContract } from './marker-contract.mjs';

const template = `- [ ] 8. Add \`DevLogger.log('[<ticket>] BUG_MARKER: <condition>')\` and commit it alone as \`debug(<ticket>): add reproduction marker\`.
- [ ] 9. Draft buggy-behavior baseline recipe.
- [ ] 10. Recorded baseline run and visual inspection.
`;

test('mobile marker step precedes baseline drafting and recording', () => {
  assert.equal(markerTemplateStep(template), template.split('\n')[0]);
});

const titledTemplate = `- [ ] 8. Add and commit the reproduction marker
  Add \`DevLogger.log('[<ticket>] BUG_MARKER: <condition>')\` at the bug condition and observe it in \`metro.log\`.
  Commit it alone as \`debug(<ticket>): add reproduction marker\`. Retain the SHA and log excerpt.
- [ ] 9. Draft the baseline recipe in reuse order
  Draft \`artifacts/recipe-baseline.json\` asserting buggy real-app behavior and require \`--plan\` PASS.
- [ ] 10. Run the recorded baseline and inspect visuals
  Run it with \`--record-video=full-run --json\` and read every visual PNG.
`;

test('titled marker instructions are read from the complete step body', () => {
  const marker = markerTemplateStep(titledTemplate);
  assert.equal(marker, titledTemplate.slice(0, titledTemplate.indexOf('- [ ] 9.')).trimEnd());
  assert.match(marker, /Commit it alone as/);
});

test('marker and baseline roles survive renumbering without relaxing their order', () => {
  for (const text of [template, titledTemplate]) {
    const changed = text.replace('8.', '28.').replace('9.', '31.').replace('10.', '42.');
    assert.match(markerTemplateStep(changed), /^- \[ \] 28\./);
  }
});

test('marker after either baseline step and ambiguous roles remain invalid', () => {
  const steps = template.trimEnd().split('\n');
  for (const changed of [
    [steps[1], steps[0], steps[2]].join('\n'),
    [steps[1], steps[2], steps[0]].join('\n'),
    template + steps[0],
    template + steps[1],
    template + steps[2],
    titledTemplate.replace('Commit it alone as', 'Commit it with the fix as'),
  ])
    assert.throws(() => markerTemplateStep(changed), /Recipe Cook mobile/);
});

test('missing or changed marker contract fails instead of skipping', () => {
  for (const changed of [
    '',
    template.replace('commit it alone', 'commit it'),
    template.replace('debug(<ticket>)', 'chore(<ticket>)'),
    template.replace('BUG_MARKER:', 'MARKER:'),
    template.replace('9. Draft buggy-behavior baseline recipe.', '9. Acceptance recipe.'),
    template.replace('Recorded baseline', 'Acceptance'),
    template.split('\n').reverse().join('\n'),
    template.replace(
      "`DevLogger.log('[<ticket>] BUG_MARKER: <condition>')`",
      '[<ticket>] BUG_MARKER: <condition>',
    ),
  ])
    assert.throws(() => markerTemplateStep(changed), /Recipe Cook mobile/);
});

test('fixture is a direct marker-only child, followed by a separate fix', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'marker-topology-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { baseSha, markerSha, patch } = await createMarkerRepo(repo, markerTemplateStep(template));
  assert.equal(fixtureGit(repo, 'rev-parse', `${markerSha}^`), baseSha);
  assert.equal(fixtureGit(repo, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(
    fixtureGit(repo, 'show', '-s', '--format=%s', markerSha),
    `debug(${MARKER_TICKET}): add reproduction marker`,
  );
  assert.equal(fixtureGit(repo, 'diff', '--numstat', baseSha, markerSha), '1\t0\tsource.mjs');
  assert.match(patch, /\+  DevLogger\.log\('\[MANUAL-000180\] BUG_MARKER: sum subtracts'\)$/);
  assert.equal(await isTicketMarkerCommit(patch, baseSha, markerSha, MARKER_TICKET), true);
  assert.equal(fixtureGit(repo, 'status', '--porcelain'), '');
  const headSha = await fixMarkerRepo(repo);
  assert.equal(fixtureGit(repo, 'rev-parse', `${headSha}^`), markerSha);
  assert.equal(fixtureGit(repo, 'show', `${baseSha}:source.mjs`).includes('BUG_MARKER'), false);
  assert.equal(fixtureGit(repo, 'show', `${headSha}:source.mjs`).includes('BUG_MARKER'), false);
});

/**
 * Run the whole contract against a template that prescribes `call`, so the
 * canary keeps measuring what it was built to measure: whether the form the
 * template tells the worker to write is the form the gateway admits.
 */
async function markerContractForTemplateCall(t: TestContext, call: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'marker-form-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const changed = template.replace('DevLogger.log', call);
  const cook = path.join(dir, 'cook');
  const direct = await createMarkerRepo(cook, markerTemplateStep(changed));
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
  return { direct, check, fixture };
}

test('console.log prescribed by the template is admitted end to end', async (t) => {
  // This case used to assert the opposite, pinning the gateway to DevLogger.log
  // alone. That is what refused every real marker: the Terminal template
  // prescribes console.log and a Mobile file without a logger must add its
  // import, so no template could produce a marker the gateway accepted. The
  // canary's job is template/gateway AGREEMENT, so console.log now has to pass.
  const { direct, check, fixture } = await markerContractForTemplateCall(t, 'console.log');
  assert.match(direct.patch, /\+  console\.log\('\[MANUAL-000180\] BUG_MARKER: sum subtracts'\)$/);
  assert.equal(
    await isTicketMarkerCommit(direct.patch, direct.baseSha, direct.markerSha, MARKER_TICKET),
    true,
  );
  assert.match(fixture.patch, /\+  console\.log\(/);
  assert.equal(
    await isTicketMarkerCommit(fixture.patch, fixture.baseSha, fixture.markerSha, MARKER_TICKET),
    true,
  );
  assert.equal(check.status, 'pass', check.error);
});

test('Logger.log prescribed by Recipe Cook Mobile records a failing baseline and passing fix', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'marker-logger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const step = markerTemplateStep(titledTemplate.replace('DevLogger.log', 'Logger.log'));
  const taskDir = path.join(dir, 'task');
  const fixture = await recordMarkerEvidence(path.join(dir, 'repo'), taskDir, step);
  assert.match(fixture.patch, /\+  Logger\.log\('\[MANUAL-000180\] BUG_MARKER: sum subtracts'\)$/);
  for (const [root, verdict] of [
    [fixture.baselineRoot, 'failed'],
    [fixture.headRoot, 'proven'],
  ]) {
    const claims = JSON.parse(
      await readFile(path.join(taskDir, 'artifacts', root, 'acceptance-status.json'), 'utf8'),
    );
    assert.equal(claims.criteria[0]?.verdict, verdict);
  }
});

test('a logger no template prescribes still reaches the gateway and is refused', async (t) => {
  // The drift this canary exists to catch: a template edited to a form the
  // gateway does not admit must fail the publish, with the same refusal. This
  // one still RUNS — the gateway refuses it for logging through a property
  // chain rather than one of the three prescribed logger names, not because the
  // fixture cannot execute it.
  const { direct, check, fixture } = await markerContractForTemplateCall(
    t,
    'globalThis.console.log',
  );
  assert.match(direct.patch, /\+  globalThis\.console\.log\(/);
  assert.equal(
    await isTicketMarkerCommit(direct.patch, direct.baseSha, direct.markerSha, MARKER_TICKET),
    false,
  );
  assert.equal(
    await isTicketMarkerCommit(fixture.patch, fixture.baseSha, fixture.markerSha, MARKER_TICKET),
    false,
  );
  assert.equal(check.status, 'fail');
  assert.match(check.error!, /Before evidence .*not the unchanged base/);
  assert.equal(
    JSON.parse(await readFile(path.join(check.evidence!, 'check.json'), 'utf8')).error,
    check.error,
  );
});
