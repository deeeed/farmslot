import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { createEvidenceReviewModel, runEvidenceView } from '@farmslot/adapter-sdk/evidence';
import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecordedEvidencePackageInput,
} from '@farmslot/protocol';
import { createRecipeRunner, createStandardCoreAdapters } from '@farmslot/recipe-runner';

import { serveRunEvidence } from '../src/harness/commands/view.js';
import { resolveProjectContext, resolveProjectViewer } from '../src/harness/context.js';
import {
  listRunEvidenceHistory,
  readRunEvidenceView,
  runEvidenceLive,
  runEvidenceSignature,
  runEvidenceViewHint,
} from '../src/harness/evidence-view.js';
import {
  DEFAULT_RUN_EVIDENCE_SECTIONS,
  loadRunEvidenceTemplate,
} from '../src/harness/evidence-view-page.js';
import { configureHarnessHost, harnessHost } from '../src/harness/host.js';

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
    view.run,
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
  assert.equal(runEvidenceLive(view), true);
  // The runner republishes trace.json after each step: the Story follows it.
  const trace = JSON.parse(fixture.files['trace.json']!) as { entries: unknown[] };
  writeRun(root, 'proof-2', {
    'trace.json': JSON.stringify({ ...trace, entries: trace.entries.slice(0, 2) }),
  });
  const stepping = await readRunEvidenceView(dir);
  assert.equal(stepping.run?.status, 'running');
  assert.deepEqual(
    stepping.steps.map(({ traceIndex, intent, ok, atMs, cue }) => [
      traceIndex,
      intent,
      ok,
      atMs,
      cue,
    ]),
    [
      [0, 'Read value 1.', true, 200, null],
      [1, 'Verify value 1.', true, 400, null],
    ],
  );
  const before = runEvidenceSignature(dir);
  // The runner writes summary.json before both manifests: the run is still finishing.
  writeRun(
    root,
    'proof-2',
    Object.fromEntries(
      Object.entries(fixture.files).filter(([name]) => name !== 'artifact-manifest.json'),
    ),
  );
  assert.notEqual(runEvidenceSignature(dir), before);
  const finishing = await readRunEvidenceView(dir);
  assert.equal(finishing.run?.status, 'running');
  assert.deepEqual(finishing.errors, [], 'a finishing run reports no missing-manifest errors');
  assert.equal(runEvidenceLive(finishing), true);
  // The manifest file exists before its bytes land: still finishing, no package errors.
  const manifest = fixture.files['artifact-manifest.json']!;
  writeRun(root, 'proof-2', { 'artifact-manifest.json': manifest.slice(0, manifest.length >> 1) });
  const partial = await readRunEvidenceView(dir);
  assert.equal(partial.run?.status, 'running');
  assert.deepEqual(partial.errors, []);
  assert.equal(runEvidenceLive(partial), true);
  writeRun(root, 'proof-2');
  const finished = await readRunEvidenceView(dir);
  assert.equal(finished.run?.status, 'pass');
  assert.equal(runEvidenceLive(finished), false);
});

test('an unreadable summary is reported, never read as a run in progress', async (t) => {
  const dir = writeRun(runsRoot(t), 'proof-3', { ...fixture.files, 'summary.json': '{"status":' });
  const view = await readRunEvidenceView(dir);
  assert.equal(view.run?.status, 'unknown');
  assert.ok(
    view.errors.some((error) => error.startsWith('summary.json is not valid JSON')),
    view.errors.join('\n'),
  );
  // A summary caught mid-write reads again on the next poll.
  assert.equal(runEvidenceLive(view), true);
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

test('the run end prints the view command unless the project turns it off', async (t) => {
  assert.equal(runEvidenceViewHint('/tmp/runs/a b', {}), "farmslot recipe view '/tmp/runs/a b'");
  assert.equal(runEvidenceViewHint('/tmp/runs/a', undefined), 'farmslot recipe view /tmp/runs/a');
  assert.equal(runEvidenceViewHint('/tmp/runs/a', { link: false }), null);
  // project.json recipe.viewer reaches the run's context and turns the line off.
  const project = runsRoot(t);
  writeProject(project, 'viewer-off', { link: false });
  const context = await resolveProjectContext({ tokens: [], cwd: project, load: { env: {} } });
  assert.deepEqual(context.project?.viewer, { link: false });
  assert.equal(runEvidenceViewHint('/tmp/runs/a', context.project?.viewer), null);
  // A host that registers no view command prints none.
  const host = harnessHost();
  configureHarnessHost({ ...host, viewCommand: undefined });
  t.after(() => configureHarnessHost(host));
  assert.equal(runEvidenceViewHint('/tmp/runs/a', undefined), null);
});

function writeProject(dir: string, name: string, viewer: unknown, repoUrl = ''): void {
  fs.mkdirSync(dir, { recursive: true });
  // Discovery reads the provider's path, never its code.
  fs.writeFileSync(path.join(dir, 'provider.mjs'), '');
  fs.writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify({
      name,
      repoUrl,
      paths: { runtimeDir: '.runtime', artifactDir: 'artifacts' },
      recipe: { provider: { module: 'provider.mjs' }, adapter: 'headless', viewer },
    }),
  );
}

test('recipe view selects a project template with no execution prerequisites', async (t) => {
  const root = runsRoot(t);
  const projectsDir = path.join(root, 'projects');
  // A registered application project for another repository, viewed from elsewhere.
  writeProject(
    path.join(projectsDir, 'app'),
    'app',
    { template: 'viewer.mjs' },
    'git@example.test:org/app.git',
  );
  writeProject(path.join(projectsDir, 'broken'), 'broken', { link: 'no' });
  const cwd = path.join(root, 'elsewhere');
  fs.mkdirSync(cwd);
  const load = { env: {} };
  const app = { root: path.join(projectsDir, 'app'), viewer: { template: 'viewer.mjs' } };
  assert.deepEqual(
    await resolveProjectViewer({ tokens: ['--project', 'app'], cwd, projectsDir, load }),
    app,
  );
  assert.equal(await resolveProjectViewer({ tokens: [], cwd, projectsDir, load }), undefined);
  await assert.rejects(
    resolveProjectViewer({ tokens: ['--project', 'typo'], cwd, projectsDir, load }),
    { code: 'PROJECT_NOT_FOUND' },
  );
  await assert.rejects(
    resolveProjectViewer({ tokens: ['--project', 'broken'], cwd, projectsDir, load }),
    /recipe\.viewer\.link is invalid/u,
  );
  // A checkout bound to the project, whose origin matches no registered repository.
  const bound = path.join(root, 'fork');
  fs.mkdirSync(path.join(bound, 'temp/recipe/runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(bound, 'temp/recipe/runtime/agentic-runtime.json'),
    JSON.stringify({ repoRoot: fs.realpathSync(bound), project: 'app' }),
  );
  const saved = process.env.RECIPE_RUNTIME_CONTEXT;
  delete process.env.RECIPE_RUNTIME_CONTEXT;
  t.after(() => {
    if (saved !== undefined) process.env.RECIPE_RUNTIME_CONTEXT = saved;
  });
  assert.deepEqual(await resolveProjectViewer({ tokens: [], cwd: bound, projectsDir, load }), app);
});

test('a retained comparison run keeps its before/after pair bound to the frozen revision', async (t) => {
  const root = runsRoot(t);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const commit = (body: string) => {
    fs.writeFileSync(path.join(root, 'source.txt'), body);
    git('add', 'source.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', body);
    return git('rev-parse', 'HEAD');
  };
  const recipe = (role: 'before' | 'after') => ({
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Compare the criterion',
    proofTargets: [{ id: 'AC-1', claim: 'The state is visible.', proofMode: 'state' }],
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'command', cmd: 'printf ok', intent: 'Read the fixture.', next: 'verify' },
        verify: {
          action: 'assert_output',
          source: 'read',
          contains: 'ok',
          proves: ['AC-1'],
          intent: 'Confirm the fixture state.',
          next: 'capture',
        },
        capture: { action: 'ui.screenshot', ac: 'AC-1', role, intent: 'Keep it.', next: 'done' },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        command: {
          description: 'Read the fixture.',
          schema: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [{ action: 'command', cmd: 'printf ok', intent: 'Read it.', next: 'done' }],
        },
        assert_output: {
          description: 'Verify the fixture.',
          schema: {
            type: 'object',
            properties: { source: { type: 'string' }, contains: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [
            {
              action: 'assert_output',
              source: 'read',
              contains: 'ok',
              intent: 'Verify it.',
              next: 'done',
            },
          ],
        },
        'ui.screenshot': {
          description: 'Capture the visible state.',
          schema: { type: 'object', properties: {}, additionalProperties: false },
          examples: [{ action: 'ui.screenshot', intent: 'Keep a picture.', next: 'done' }],
        },
        end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
      },
    },
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
    adapters: [
      ...createStandardCoreAdapters({ actions: ['command', 'assert_output'] }),
      {
        action: 'ui.screenshot',
        source: { kind: 'bundled', trust: 'trusted' },
        async execute(_node, context) {
          fs.writeFileSync(context.resolveArtifactPath('capture.png'), 'media bytes');
          const artifact = { path: 'capture.png', type: 'screenshot' };
          context.registerArtifact(artifact);
          return { artifacts: [artifact] };
        },
      },
    ],
  });
  const run = (role: 'before' | 'after', dir: string, extra = {}) =>
    runner.run({
      recipeDocument: recipe(role),
      projectRoot: root,
      artifactsDir: dir,
      recordVideo: false,
      recordingReason: 'Fixture has no recorder.',
      ...extra,
    });
  const baseSha = commit('before');
  const baselineDir = path.join(root, 'runs', 'baseline');
  const baseline = await run('before', baselineDir);
  const headSha = commit('after');
  const headDir = path.join(root, 'runs', 'head');
  await run('after', headDir, {
    comparisonDependencies: [baselineDir],
    comparisonSnapshot: { baseSha, headSha },
  });
  const view = await readRunEvidenceView(headDir);
  assert.deepEqual(view.errors, []);
  const criterion = view.criteria.find((entry) => entry.id === 'AC-1')!;
  assert.deepEqual(criterion.pair && [criterion.pair.before.path, criterion.pair.after.path], [
    `comparison-dependencies/${baseline.claims!.recipeRunId}/capture.png`,
    'capture.png',
  ]);
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
  // The Story view: every executed intent in trace order with its time from the run start.
  const story = page.body.slice(page.body.indexOf('<section class="story">'));
  assert.deepEqual(
    [...story.matchAll(/data-trace-index="(\d+)"/gu)].map((match) => Number(match[1])),
    [0, 1, 2],
  );
  assert.match(
    story,
    /<button type="button" class="beat" data-seek-video="video\.mp4" data-seek-ms="400"><span class="at">0:00\.40<\/span>/u,
  );
  assert.match(page.body, /<a href="#story" data-mode-link="story">Story<\/a>/u);
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
    ['header', 'issues', 'player', 'criteria', 'story', 'timeline', 'history'],
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
