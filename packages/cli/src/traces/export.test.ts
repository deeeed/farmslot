import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { exportRunTraces, type TraceExportStores } from './export.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const put = async (file: string, text: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

async function stores(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const s: TraceExportStores = {
    episodes: path.join(root, 'episodes'),
    runs: path.join(root, 'runs'),
    runArchive: path.join(root, 'run-archive'),
    projects: path.join(root, 'projects'),
    pool: path.join(root, 'pool'),
    bundleStoreRoot: path.join(root, 'run-bundles'),
    home: path.join(root, 'home'),
  };
  await put(path.join(s.projects, 'farm', 'project.json'), '{}');
  await put(path.join(s.projects, 'private', 'project.json'), '{"traces":{"enabled":false}}');
  await put(path.join(s.pool, 'macwork.json'), '{"machine":"macwork","sshTarget":"ops@macwork"}');

  const worker = `${JSON.stringify({ type: 'user', text: 'work in /Users/ops/repo on macwork' })}\n`;
  const reviewer = `${JSON.stringify({ type: 'assistant', text: 'looks fine' })}\n`;
  const grok = `${JSON.stringify({ role: 'user', content: 'hi', timestamp: '2026-11-24T10:00:00Z' })}\n${JSON.stringify({ role: 'weird' })}\n`;
  // Worker transcript in place; reviewer moved to the run archive; grok in place.
  await put(path.join(s.runs, 'session-archives/run-1/dev/w1/transcript.jsonl'), worker);
  const source = path.join(s.runs, 'session-archives/run-1/review');
  const destination = path.join(s.runArchive, 'run-1', 'gen-1', 'review');
  await put(path.join(destination, 'r1/transcript.jsonl'), reviewer);
  await put(
    path.join(s.runArchive, 'run-1', 'manifest.json'),
    JSON.stringify({
      runId: 'run-1',
      entries: [{ source, destination, completedAt: 'x', staged: 'y', store: 'session-archives' }],
    }),
  );
  await put(path.join(s.runs, 'session-archives/run-1/grok/g1/transcript.jsonl'), grok);
  const diff = 'diff --git a/x b/x\n+line\n';
  await put(path.join(s.episodes, 'outputs/run-1/graded.diff'), diff);
  await put(
    path.join(s.episodes, 'grades/run-1.jsonl'),
    [
      JSON.stringify({ source: 'eval', grader: 'sparks', verdict: 'wrong' }),
      JSON.stringify({ source: 'eval', grader: 'sparks', verdict: 'partial' }),
    ].join('\n') + '\n',
  );
  await put(path.join(s.episodes, 'interviews/run-1/001-why.md'), 'Because ops asked.\n');
  await put(path.join(s.episodes, 'interviews/run-1/.001'), '');
  await put(
    path.join(s.runs, 'run-1.json'),
    JSON.stringify({ id: 'run-1', humanGrade: { recipe_semantic: 'ok' } }),
  );

  const episode = (runId: string, project: string, agents: unknown[], extra = {}) =>
    put(
      path.join(s.episodes, `${runId}.json`),
      JSON.stringify({
        schema: 'farmslot-episode-v1',
        runId,
        project,
        flowType: 'dev',
        status: 'done',
        runUpdatedAt: '2026-11-24T10:00:00Z',
        trajectory: { agents },
        labels: {
          outcome: 'success',
          task: { familyId: 'fam-1' },
          roles: [{ contextId: 'dev', model: 'claude-opus-5-5' }],
          cost: [
            {
              contextId: 'dev',
              role: 'dev',
              inputTokens: 1_000_000,
              outputTokens: 0,
              cacheReadTokens: 0,
              usd: null,
              usdSource: null,
            },
          ],
          output: {
            diffSha256: sha(diff),
            source: 'committed',
            ref: 'abc',
            path: 'outputs/run-1/graded.diff',
            sizeBytes: diff.length,
          },
          ...extra,
        },
      }),
    );
  await episode('run-1', 'farm', [
    {
      contextId: 'dev',
      runner: 'claude',
      sessions: [
        {
          sessionKey: 'w1',
          status: 'captured',
          relativeDir: 'session-archives/run-1/dev/w1',
          sha256: sha(worker),
        },
      ],
    },
    {
      contextId: 'review',
      runner: 'codex',
      sessions: [
        {
          sessionKey: 'r1',
          status: 'captured',
          relativeDir: 'session-archives/run-1/review/r1',
          sha256: sha(reviewer),
        },
        { sessionKey: 'r2', status: 'missing' },
      ],
    },
    {
      contextId: 'grok',
      runner: 'grok',
      sessions: [
        { sessionKey: 'g1', status: 'captured', relativeDir: 'session-archives/run-1/grok/g1' },
      ],
    },
    {
      contextId: 'bad',
      runner: 'claude',
      sessions: [
        {
          sessionKey: 'b1',
          status: 'captured',
          relativeDir: 'session-archives/run-1/dev/w1',
          sha256: 'f'.repeat(64),
        },
      ],
    },
  ]);
  await episode('run-2', 'private', []);
  return { root, s };
}

test('an export writes redacted transcripts, labels, grades, interviews and the graded diff', async (t) => {
  const { root, s } = await stores(t);
  const out = path.join(root, 'out');
  const result = await exportRunTraces({ out }, s);
  assert.equal(result.exported, 1);
  assert.deepEqual(result.skipped, [
    { runId: 'run-2', reason: 'project opted out (traces.enabled: false)' },
  ]);
  assert.deepEqual(result.transcripts, { present: 3, missing: 2 });

  const run = path.join(out, 'runs', 'run-1');
  const worker = await readFile(path.join(run, 'transcripts', 'dev-w1.jsonl'), 'utf8');
  assert.match(worker, /~\/repo on <machine>/);
  // Archived through its manifest.
  assert.ok(existsSync(path.join(run, 'transcripts', 'review-r1.jsonl')));
  // Grok becomes the Session Trace Simple Format; the unmappable record is counted.
  const grok = (await readFile(path.join(run, 'transcripts', 'grok-g1.jsonl'), 'utf8')).split('\n');
  assert.deepEqual(JSON.parse(grok[0]!), {
    type: 'session',
    harness: 'farmslot-grok',
    id: 'g1',
    name: 'run-1',
  });
  assert.equal(JSON.parse(grok[1]!).message.role, 'user');
  assert.equal(JSON.parse(await readFile(path.join(run, 'redaction.json'), 'utf8')).unmapped, 1);

  const labels = JSON.parse(await readFile(path.join(run, 'labels.json'), 'utf8'));
  assert.deepEqual(
    labels.externalGrades.map((g: { verdict: string }) => g.verdict),
    ['partial'],
  );
  assert.deepEqual(labels.humanGrade, { recipe_semantic: 'ok' });
  assert.equal(labels.labels.cost[0].usd, 4);
  assert.equal(labels.labels.cost[0].usdSource, 'export-table');
  assert.deepEqual(
    labels.transcripts
      .filter((entry: { status: string }) => entry.status !== 'present')
      .map((entry: { sessionKey: string; status: string }) => [entry.sessionKey, entry.status]),
    [
      ['r2', 'missing'],
      ['b1', 'sha256-mismatch'],
    ],
  );
  assert.equal(
    await readFile(path.join(run, 'output.diff'), 'utf8'),
    'diff --git a/x b/x\n+line\n',
  );
  assert.equal(
    await readFile(path.join(run, 'interviews', '001-why.md'), 'utf8'),
    // `ops` is the pool host's SSH user.
    'Because [REDACTED:username] asked.\n',
  );
  assert.ok(!existsSync(path.join(run, 'interviews', '.001')));

  const index = (await readFile(path.join(out, 'index.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(index.length, 1);
  assert.equal(index[0].transcripts.present, 3);
  assert.match(await readFile(path.join(out, 'README.md'), 'utf8'), /run-2: project opted out/);
});

test('a non-empty directory is refused unless --update, which adds and keeps', async (t) => {
  const { root, s } = await stores(t);
  const out = path.join(root, 'out');
  await exportRunTraces({ out }, s);
  await assert.rejects(exportRunTraces({ out }, s), /not empty; pass --update/);
  // A later grade reaches labels.json on --update; a run outside the new filter stays indexed.
  await put(
    path.join(s.episodes, 'grades/run-1.jsonl'),
    `${JSON.stringify({ source: 'eval', grader: 'sparks', verdict: 'match' })}\n`,
  );
  await exportRunTraces({ out, update: true, project: 'farm' }, s);
  const labels = JSON.parse(await readFile(path.join(out, 'runs/run-1/labels.json'), 'utf8'));
  assert.equal(labels.externalGrades[0].verdict, 'match');
  await exportRunTraces({ out, update: true, project: 'nobody' }, s);
  assert.equal(
    (await readFile(path.join(out, 'index.jsonl'), 'utf8')).trim().split('\n').length,
    1,
  );
});

test('filters select by family and grade', async (t) => {
  const { root, s } = await stores(t);
  assert.equal(
    (await exportRunTraces({ out: path.join(root, 'a'), family: 'other' }, s)).exported,
    0,
  );
  assert.equal(
    (await exportRunTraces({ out: path.join(root, 'b'), hasGrade: true }, s)).exported,
    1,
  );
});

test('TASK.md comes from the retained bundle, read without opening the store', async (t) => {
  const { root, s } = await stores(t);
  const task = '# Task\nOpen the order book.\n';
  const key = 'tasks/task-1/TASK.md';
  const manifest = JSON.stringify({
    entries: { [key]: { path: key, sha256: sha(task), bytes: task.length } },
  });
  const digest = sha(manifest);
  const dir = path.join(s.bundleStoreRoot, 'sha256', digest);
  await put(path.join(dir, 'manifest.json'), manifest);
  await put(path.join(dir, key), task);
  await put(
    path.join(s.runs, 'run-1.json'),
    JSON.stringify({ id: 'run-1', artifactBundle: { bundleDigest: digest, taskKey: 'task-1' } }),
  );
  const out = path.join(root, 'out');
  await exportRunTraces({ out }, s);
  assert.equal(await readFile(path.join(out, 'runs/run-1/task.md'), 'utf8'), task);
  // A tampered file is left out, never exported.
  await writeFile(path.join(dir, key), '# Task\ntampered\n');
  const second = path.join(root, 'out2');
  await exportRunTraces({ out: second }, s);
  assert.ok(!existsSync(path.join(second, 'runs/run-1/task.md')));
});
