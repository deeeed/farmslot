import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { exportRunTraces, gatewayTraceStores, type TraceExportStores } from './export.js';

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
    profiles: path.join(root, 'home', 'config', 'gateways.json'),
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

test('the index and README are scrubbed like every other file', async (t) => {
  const { root, s } = await stores(t);
  // A run id carrying the pool user's name must not leak through the index or README.
  await put(
    path.join(s.episodes, 'ops-run.json'),
    JSON.stringify({
      schema: 'farmslot-episode-v1',
      runId: 'ops-run',
      project: 'private',
      status: 'done',
    }),
  );
  const out = path.join(root, 'out');
  await exportRunTraces({ out }, s);
  assert.doesNotMatch(await readFile(path.join(out, 'README.md'), 'utf8'), /\bops-run\b/);
  assert.doesNotMatch(await readFile(path.join(out, 'index.jsonl'), 'utf8'), /\bops\b/);
});

test("the gateway host's secret files feed the secret-value rule", async (t) => {
  const { root, s } = await stores(t);
  const { traceScrubInputs } = await import('./export.js');
  const userHome = path.join(root, 'user');
  await put(
    path.join(s.home, 'providers.env'),
    'export OPENAI_API_KEY="sk-provider-value-1234"\nBASE=https://x\n',
  );
  await put(path.join(s.home, 'node.secret'), 'node-token-value-5678\n');
  await put(
    path.join(userHome, '.farmslot-automation', 'macwork-node-automation.secret'),
    'automation-token-9999\n',
  );
  await put(path.join(userHome, '.config', 'litellm', 'api-key'), 'litellm-key-0000\n');
  const inputs = await traceScrubInputs(s, userHome, {});
  for (const value of [
    'sk-provider-value-1234',
    'node-token-value-5678',
    'automation-token-9999',
    'litellm-key-0000',
  ])
    assert.ok(inputs.secretValues.includes(value), value);
});

test('a date-only --until covers that whole day; a bad date is refused', async () => {
  const { normalizeTraceRange } = await import('./export.js');
  assert.deepEqual(normalizeTraceRange({ since: '2026-11-24', until: '2026-11-24' }), {
    since: '2026-11-24T00:00:00.000Z',
    until: '2026-11-24T23:59:59.999Z',
  });
  assert.throws(() => normalizeTraceRange({ since: 'last week' }), /--since must be an ISO date/);
});

test('provider values that are not secrets stay; client profile tokens are secrets', async (t) => {
  const { root, s } = await stores(t);
  const { traceScrubInputs } = await import('./export.js');
  await put(
    path.join(s.home, 'providers.env'),
    'OPENAI_BASE_URL=https://api.example.test/v1\nDEFAULT_MODEL=claude-opus-5-5\n',
  );
  await put(
    s.profiles,
    JSON.stringify({
      active: 'local',
      gateways: { local: { url: 'ws://x', authMode: 'token', secret: 'client-profile-token-1' } },
    }),
  );
  const inputs = await traceScrubInputs(s, path.join(root, 'user'), {});
  assert.ok(inputs.secretValues.includes('client-profile-token-1'));
  assert.ok(!inputs.secretValues.includes('claude-opus-5-5'));
  assert.ok(!inputs.secretValues.includes('https://api.example.test/v1'));
});

test('one unreadable run record skips its run, and index redactions are counted', async (t) => {
  const { root, s } = await stores(t);
  await put(path.join(s.runs, 'run-1.json'), '{not json');
  const out = path.join(root, 'out');
  const result = await exportRunTraces({ out }, s);
  assert.equal(result.exported, 0);
  assert.match(
    result.skipped.find((entry) => entry.runId === 'run-1')?.reason ?? '',
    /not valid JSON/,
  );
  const counts = JSON.parse(await readFile(path.join(out, 'redaction.json'), 'utf8'));
  assert.ok('indexAndReadme' in counts);
});

test(
  'an unreadable interview skips its run, not the export',
  { skip: process.getuid?.() === 0 && 'root reads every file' },
  async (t) => {
    const { root, s } = await stores(t);
    const { chmod } = await import('node:fs/promises');
    const file = path.join(s.episodes, 'interviews/run-1/001-why.md');
    await chmod(file, 0o000);
    try {
      const result = await exportRunTraces({ out: path.join(root, 'out') }, s);
      assert.match(
        result.skipped.find((entry) => entry.runId === 'run-1')?.reason ?? '',
        /001-why\.md/,
      );
    } finally {
      // Before the fixture's own cleanup removes the directory.
      await chmod(file, 0o644);
    }
  },
);

test('the scan hook is off by default; when set it runs on the written export', async (t) => {
  const { root, s } = await stores(t);
  const plain = await exportRunTraces({ out: path.join(root, 'plain'), scanHook: '' }, s);
  assert.equal(plain.scanHook, 'none');
  assert.match(await readFile(path.join(root, 'plain/README.md'), 'utf8'), /Scan hook: none/);
  // The hook gets the directory, sees every file written, and may redact in place.
  const hook = path.join(root, 'hook.sh');
  await put(
    hook,
    'test -f "$1/index.jsonl" || exit 9\nprintf scanned > "$1/SCANNED"\n[ "$FARMSLOT_TRACE_EXPORT_DIR" = "$1" ]\n',
  );
  const out = path.join(root, 'scanned');
  const result = await exportRunTraces({ out, scanHook: `sh ${hook}` }, s);
  assert.equal(result.scanHook, 'passed');
  assert.equal(await readFile(path.join(out, 'SCANNED'), 'utf8'), 'scanned');
  assert.match(await readFile(path.join(out, 'README.md'), 'utf8'), /Scan hook: sh /);
});

test('a failing scan hook refuses the export until a later run passes', async (t) => {
  const { root, s } = await stores(t);
  const out = path.join(root, 'out');
  const refuse = path.join(root, 'refuse.sh');
  await put(refuse, 'echo "found a key in runs/run-1" >&2\nexit 3\n');
  await assert.rejects(
    exportRunTraces({ out, scanHook: `sh ${refuse}` }, s),
    /scan hook refused the export \(exit 3\)/,
  );
  assert.match(await readFile(path.join(out, 'REFUSED.md'), 'utf8'), /found a key in runs\/run-1/);
  await exportRunTraces({ out, update: true, scanHook: 'true' }, s);
  assert.equal(existsSync(path.join(out, 'REFUSED.md')), false);
});

test('the installed CLI refuses to guess the gateway checkout in the legacy layout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-stores-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'farmslot-cli/sha');
  const runs = path.join(root, 'gateway/.runs');
  await mkdir(path.join(runs, 'episodes'), { recursive: true });
  await mkdir(snapshot, { recursive: true });
  const env = { FARMSLOT_HOME: path.join(root, 'home'), FARMSLOT_RUNS_DIR: runs };
  // The episodes are found, but projects and pool would come from the snapshot.
  assert.throws(() => gatewayTraceStores(env, snapshot), /gateway checkout is unknown/);
  const dirs = {
    FARMSLOT_PROJECTS_DIR: path.join(root, 'gateway/projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'gateway/pool'),
  };
  assert.equal(
    gatewayTraceStores({ ...env, ...dirs }, snapshot).episodes,
    path.join(runs, 'episodes'),
  );
  // A git checkout is the gateway's own (the CLI running from source there).
  await mkdir(path.join(snapshot, '.git'));
  assert.equal(gatewayTraceStores(env, snapshot).projects, path.join(snapshot, 'projects'));
});
