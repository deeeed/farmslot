import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { createEvidenceReviewModel, runEvidenceView } from '@farmslot/adapter-sdk/evidence';
import type { RecordedEvidencePackageInput } from '@farmslot/protocol';

import { serveRunEvidence } from '../src/harness/commands/view.js';
import {
  listRunEvidenceHistory,
  readRunEvidenceView,
  runEvidenceSignature,
  runEvidenceViewHint,
} from '../src/harness/evidence-view.js';
import {
  DEFAULT_RUN_EVIDENCE_SECTIONS,
  loadRunEvidenceTemplate,
} from '../src/harness/evidence-view-page.js';

const fixture = JSON.parse(
  fs.readFileSync(
    new URL('../../recipe-runner/test/fixtures/visual-review-package.json', import.meta.url),
    'utf8',
  ),
) as { files: Record<string, string>; input: RecordedEvidencePackageInput };

function writeRun(root: string, id: string, files = fixture.files): string {
  const dir = path.join(root, id);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function runsRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-evidence-view-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The runner writes these before the first step; summary and trace land at the end. */
const startedFiles = Object.fromEntries(
  Object.entries(fixture.files).filter(([name]) =>
    ['recipe.json', 'recipe-invocation.json'].includes(name),
  ),
);

test('a finished run folder reads as the same view the shared review model projects', async (t) => {
  const dir = writeRun(runsRoot(t), 'proof-1');
  const view = await readRunEvidenceView(dir);
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.run, {
    id: 'proof-1',
    title: 'Review composed QA cases.',
    status: 'pass',
    startedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(
    view.criteria.map(({ id, verdict, cue }) => [id, verdict, cue]),
    [
      ['case-1', 'awaiting-review', { videoPath: 'video.mp4', startMs: 0, endMs: 1_700 }],
      ['check-1', 'awaiting-review', { videoPath: 'video.mp4', startMs: 0, endMs: 1_700 }],
    ],
  );
  assert.deepEqual(
    view.steps.map(({ traceIndex, intent, ok, cue }) => [traceIndex, intent, ok, cue?.startMs]),
    [
      [0, 'Read value 1.', true, 200],
      [1, 'Verify value 1.', true, 400],
      [2, 'done', true, 1_800],
    ],
  );
  // One implementation: the folder reader adds nothing the shared projection does not.
  const shared = runEvidenceView(
    createEvidenceReviewModel({ context: 'artifact', package: fixture.input }),
  );
  assert.deepEqual(view.criteria, shared.criteria);
  assert.deepEqual(view.steps, shared.steps);
});

test('a run in progress lists its declared criteria unjudged and goes live', async (t) => {
  const root = runsRoot(t);
  const dir = writeRun(root, 'proof-2', startedFiles);
  const view = await readRunEvidenceView(dir);
  assert.equal(view.run?.status, 'running');
  assert.equal(view.run?.startedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(
    view.criteria.map(({ id, text, verdict }) => [id, text, verdict]),
    [
      ['case-1', 'Case 1 succeeds.', null],
      ['check-1', 'Value 1 is observed.', null],
    ],
  );
  assert.deepEqual(view.steps, []);
  const before = runEvidenceSignature(dir);
  writeRun(root, 'proof-2');
  assert.notEqual(runEvidenceSignature(dir), before);
  assert.equal((await readRunEvidenceView(dir)).run?.status, 'pass');
});

test('history lists the run folders beside each other, newest first', (t) => {
  const root = runsRoot(t);
  writeRun(root, 'older');
  const newer = { ...startedFiles };
  newer['recipe-invocation.json'] = startedFiles['recipe-invocation.json']!.replace(
    '2026-01-01T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
  );
  writeRun(root, 'newer', newer);
  fs.mkdirSync(path.join(root, 'not-a-run'));
  assert.deepEqual(
    listRunEvidenceHistory(root).map(({ id, status }) => [id, status]),
    [
      ['newer', 'running'],
      ['older', 'pass'],
    ],
  );
});

test('the run end prints the view command unless the project turns it off', () => {
  assert.equal(runEvidenceViewHint('/tmp/runs/a b', {}), "farmslot recipe view '/tmp/runs/a b'");
  assert.equal(runEvidenceViewHint('/tmp/runs/a', undefined), 'farmslot recipe view /tmp/runs/a');
  assert.equal(runEvidenceViewHint('/tmp/runs/a', { link: false }), null);
});

async function get(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

test('recipe view serves a read-only page, the files and the view-model of one run', async (t) => {
  const root = runsRoot(t);
  const dir = writeRun(root, 'proof-1');
  writeRun(root, 'proof-0');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside the run');
  const server = await serveRunEvidence({ dir });
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/runs\/proof-1\/$/u);
  const page = await get(server.url);
  assert.equal(page.status, 200);
  assert.match(page.body, /<code>check-1<\/code>/u);
  assert.match(page.body, /data-seek-video="video\.mp4" data-seek-ms="0"/u);
  assert.match(page.body, /id="step-1"/u);
  assert.match(page.body, /href="\/runs\/proof-0\/"/u, 'the history lists the sibling run');
  assert.doesNotMatch(page.body, /data-live="1"/u, 'a finished run does not poll');

  const video = await get(`${server.url}files/video.mp4`, { headers: { range: 'bytes=0-7' } });
  assert.equal(video.status, 206);
  assert.equal(video.body, 'original');
  assert.equal(video.headers.get('content-range'), 'bytes 0-7/18');

  const json = JSON.parse((await get(`${server.url}view.json`)).body) as { criteria: unknown };
  assert.deepEqual(json.criteria, (await readRunEvidenceView(dir)).criteria);

  for (const outside of [
    `${server.url}files/..%2F..%2Fsecret.txt`,
    `${server.url}files/%2E%2E/%2E%2E/secret.txt`,
    `${server.url.replace('proof-1', '..')}files/secret.txt`,
  ])
    assert.equal((await get(outside)).status, 404, outside);
  assert.equal((await get(server.url, { method: 'POST' })).status, 405);
});

test('recipe view on a folder of runs serves the live history index', async (t) => {
  const root = runsRoot(t);
  writeRun(root, 'proof-1');
  writeRun(root, 'proof-2', startedFiles);
  const server = await serveRunEvidence({ dir: root });
  t.after(() => server.close());
  const index = await get(server.url);
  assert.match(index.body, /data-live="1" data-version-url="\/version"/u);
  assert.match(index.body, /href="\/runs\/proof-1\/"/u);
  const running = await get(`${server.url}runs/proof-2/`);
  assert.match(running.body, /data-live="1" data-version-url="\/runs\/proof-2\/version"/u);
  assert.equal(
    (await get(`${server.url}runs/proof-2/version`)).body,
    runEvidenceSignature(path.join(root, 'proof-2')),
  );
});

test('a project template reorders and adds sections; the default layout stays unchanged', async (t) => {
  const root = runsRoot(t);
  const dir = writeRun(root, 'proof-1');
  const module = path.join(root, 'template.mjs');
  fs.writeFileSync(
    module,
    `export default {
  styles: '.wallet{color:red}',
  sections: (defaults) => [
    { id: 'wallet', render: (view, ctx) => '<section class="wallet">Wallet ' + ctx.escape(view.run.id) + '</section>' },
    ...defaults.filter((section) => section.id !== 'history'),
  ],
};`,
  );
  const template = await loadRunEvidenceTemplate(module);
  const server = await serveRunEvidence({ dir, template });
  t.after(() => server.close());
  const body = (await get(server.url)).body;
  assert.ok(body.indexOf('Wallet proof-1') < body.indexOf('class="run-header"'));
  assert.match(body, /\.wallet\{color:red\}/u);
  assert.deepEqual(
    DEFAULT_RUN_EVIDENCE_SECTIONS.map((section) => section.id),
    ['header', 'issues', 'player', 'criteria', 'timeline', 'history'],
  );
  fs.writeFileSync(module.replace('.mjs', '-bad.mjs'), 'export default { sections: 1 };');
  await assert.rejects(
    loadRunEvidenceTemplate(module.replace('.mjs', '-bad.mjs')),
    /must export a run evidence template/u,
  );
});

test('criterion text is escaped on the page', async (t) => {
  const root = runsRoot(t);
  const files = { ...fixture.files };
  files['acceptance-status.json'] = files['acceptance-status.json']!.replace(
    'Value 1 is observed.',
    '<img src=x onerror=alert(1)>',
  );
  const dir = writeRun(root, 'proof-1', files);
  const server = await serveRunEvidence({ dir });
  t.after(() => server.close());
  const body = (await get(server.url)).body;
  assert.doesNotMatch(body, /<img src=x/u);
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/u);
});
