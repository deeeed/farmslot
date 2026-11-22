import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { recordRecipeAttemptSelection } from '@farmslot/agent-runtime/scripts/retained-recipe-attempt.cjs';
import { digestRecipeDocument } from '@farmslot/protocol';

import {
  renderRetainedArtifactsMarkdown,
  renderTaskArtifactsMarkdown,
} from '../src/harness/commands/artifacts-markdown.js';
import { renderRecipeTranscript } from '../src/harness/commands/transcript.js';

const REPORT_DIR = 'temp/tasks/feat/t-1/artifacts/proof';
const PROSE =
  '## **Description**\n\nAuthored.\n\n## **Pre-merge author checklist**\n\n- [x] Done\n';
const RUNNER = { name: 'fixture-runner', source: 'fixture/runner', git_ref: 'fixture-revision' };
const RECIPE = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Permissioned dex on testnet, Core',
  description: 'Headless controller proof.',
  workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
};

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function entry(nodeId: string, action: string, ok: boolean, output: unknown, extra = {}) {
  return {
    nodeId,
    action,
    ok,
    startedAt: '2026-11-22T12:56:18.050Z',
    endedAt: '2026-11-22T12:56:18.161Z',
    durationMs: 111,
    output,
    ...extra,
  };
}

/** The TAT-4334 shape: commands writing reports, assert_json reading them, index_artifacts. */
async function headlessPackage(dir: string, entries?: unknown[]): Promise<string> {
  await writeJson(path.join(dir, 'recipe.json'), RECIPE);
  await writeJson(path.join(dir, 'recipe-resolution.json'), {
    schema_version: 1,
    root: { ref: '$root', digest: 'sha256:24d0f2dc' },
  });
  await writeJson(path.join(dir, 'summary.json'), {
    recipeRunId: '2f515d55-run',
    status: 'pass',
    total: 5,
    passed: 5,
    failed: 0,
    runner: RUNNER,
  });
  await writeJson(path.join(dir, 'product-provenance.json'), {
    schemaVersion: 1,
    adapter: 'core',
    git_ref: 'a55ff20d2ff4947d06500e9d2cf14dcabdfe803f',
    dirty: false,
  });
  await writeJson(path.join(dir, 'recipe-invocation.json'), {
    version: 1,
    params: {
      dex: 'ignp',
      api_token: 'live-secret-value',
      output_dir: REPORT_DIR,
    },
    redactedPaths: [],
  });
  await writeJson(path.join(dir, 'acceptance-status.json'), {
    schemaVersion: 2,
    recipeRunId: '2f515d55-run',
    criteria: [
      {
        id: 'AC3',
        text: 'Allowlisted wallet trades with fill ids',
        kind: 'acceptance',
        proofMode: 'state',
        verdict: 'pass',
        recipeNodes: ['ac3-trade', 'ac3-assert'],
        assertionIndices: [0],
        evidence: [],
        moments: [],
      },
    ],
    recording: { status: 'not-required', segments: [] },
  });
  await writeJson(path.join(dir, REPORT_DIR, 'trade.json'), {
    network: 'testnet',
    ok: true,
    filledOrderIds: ['65789464128', '65789464992', '65789476114', '65789485775'],
    missingFills: [],
    session: { authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123' },
  });
  await writeJson(path.join(dir, 'trace.json'), {
    metadata: { runner: RUNNER },
    entries: entries ?? [
      entry('setup', 'command', true, { exitCode: 0, stdout: '', stderr: '' }),
      entry('ac3-trade', 'command', true, {
        exitCode: 0,
        stdout: `{"phase":"trade","ok":true} token=sk-abcdefghijklmnop ${os.homedir()}/x\n`,
        stderr: '',
      }),
      entry('ac3-assert', 'assert_json', true, {
        path: `${REPORT_DIR}/trade.json`,
        assertion: {
          all: [
            { path: '$.ok', operator: 'eq', value: true },
            { path: '$.filledOrderIds', operator: 'length_gte', value: 2 },
            { path: '$.missingFills', operator: 'length_eq', value: 0 },
            { path: '$.session.authorization', operator: 'exists' },
          ],
        },
      }),
      entry('evidence', 'index_artifacts', true, { artifacts: [`${REPORT_DIR}/trade.json`] }),
      entry('done', 'end', true, {}),
    ],
  });
  return dir;
}

async function root(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'recipe-transcript-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('renders one deterministic line per node with provenance, asserted values and criteria', async (t) => {
  const dir = await headlessPackage(path.join(await root(t), 'package'));
  const text = await renderRecipeTranscript({ artifactDir: dir, displayDir: 'recipe-runs/r1' });
  assert.equal(
    await renderRecipeTranscript({ artifactDir: dir, displayDir: 'recipe-runs/r1' }),
    text,
  );
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length <= 40, `${lines.length} lines`);
  assert.equal(lines[0], 'Recipe: Permissioned dex on testnet, Core');
  assert.equal(lines[1], 'Run 2f515d55-run · digest sha256:24d0f2dc');
  assert.equal(
    lines[2],
    'Commit a55ff20d2ff4947d06500e9d2cf14dcabdfe803f (clean) · network testnet',
  );
  assert.match(text, /^✓ setup {2}command {2}exit 0$/m);
  assert.match(
    text,
    /^✓ ac3-assert {2}assert_json {2}trade\.json · ok=true · filledOrderIds=\[4\] "65789464128","65789464992",\+2 \(len≥2\) · missingFills=\[0\] \(len=0\)/m,
  );
  assert.match(text, /^✓ evidence {2}index_artifacts {2}indexed 1$/m);
  assert.match(text, /^✓ done {2}end$/m);
  assert.match(text, /^5\/5 nodes passed · status pass$/m);
  assert.match(text, /^AC3 pass \[state\] ← ac3-trade, ac3-assert$/m);
  assert.equal(lines.at(-1), 'Artifacts: recipe run r1 (trace.json, report.md)');
  assert.match(text, /^Inputs: .*output_dir=…\/proof$/m);
  assert.doesNotMatch(text, /temp\/|recipe-runs\//);
});

test('redacts credentials from inputs, outputs and retained reports', async (t) => {
  const dir = await headlessPackage(path.join(await root(t), 'package'));
  const text = await renderRecipeTranscript({ artifactDir: dir });
  assert.match(text, /Inputs: dex=ignp · api_token=<redacted> ·/);
  assert.match(text, /session\.authorization="<redacted>"/);
  assert.doesNotMatch(text, /live-secret-value|ghp_abcdef|sk-abcdef|Bearer /);
  assert.doesNotMatch(text, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/x'));
});

test('a failed node shows expected and actual values; long traces keep every failure', async (t) => {
  const passing = Array.from({ length: 40 }, (_, index) =>
    entry(`step-${index}`, 'command', true, { exitCode: 0, stdout: '', stderr: '' }),
  );
  const failed = entry(
    'ac3-assert',
    'assert_json',
    false,
    {
      path: `${REPORT_DIR}/trade.json`,
      assertion: { path: '$.filledOrderIds', operator: 'length_gte', value: 9 },
    },
    { error: { message: 'filledOrderIds expected length_gte 9' } },
  );
  const dir = await headlessPackage(path.join(await root(t), 'package'), [...passing, failed]);
  const text = await renderRecipeTranscript({ artifactDir: dir });
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length <= 40, `${lines.length} lines`);
  assert.match(
    text,
    /^✗ ac3-assert {2}assert_json {2}trade\.json · filledOrderIds=\[4\] .* \(len≥9\)$/m,
  );
  assert.match(text, /^… 9 more nodes in trace\.json \(0 failed\)$/m);
});

test('a package without declared criteria says so instead of inventing them', async (t) => {
  const dir = await headlessPackage(path.join(await root(t), 'package'));
  await writeJson(path.join(dir, 'acceptance-status.json'), {
    schemaVersion: 2,
    recipeRunId: '2f515d55-run',
    criteria: [],
    recording: { status: 'not-required', segments: [] },
  });
  const text = await renderRecipeTranscript({ artifactDir: dir });
  assert.match(
    text,
    /^Criteria: none declared \(no recipe proofTargets, none in the run acceptance-status\.json\)$/m,
  );
});

test('criteria fall back to the same run task ledger when the package declares none', async (t) => {
  const base = await root(t);
  const dir = await headlessPackage(path.join(base, 'package'));
  const empty = {
    schemaVersion: 2,
    recipeRunId: '2f515d55-run',
    criteria: [],
    recording: { status: 'not-required', segments: [] },
  };
  await writeJson(path.join(dir, 'acceptance-status.json'), empty);
  const claim = {
    id: 'AC2',
    text: 'Controller loads the dex markets',
    kind: 'acceptance',
    proofMode: 'state',
    verdict: 'pass',
    recipeNodes: ['ac2-assert'],
    assertionIndices: [0],
    evidence: [],
    moments: [],
  };
  const runLedgerDir = path.join(base, 'task-artifacts');
  await writeJson(path.join(runLedgerDir, 'acceptance-status.json'), {
    ...empty,
    criteria: [claim],
  });
  assert.match(
    await renderRecipeTranscript({ artifactDir: dir, runLedgerDir }),
    /^AC2 pass \[state\] ← ac2-assert$/m,
  );
  await writeJson(path.join(runLedgerDir, 'acceptance-status.json'), {
    ...empty,
    recipeRunId: 'older-run',
    criteria: [claim],
  });
  assert.match(
    await renderRecipeTranscript({ artifactDir: dir, runLedgerDir }),
    /^Criteria: none declared/m,
  );
});

test('task Markdown puts the selected attempt transcript in the validation logs only on request', async (t) => {
  const taskDir = await root(t);
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/pr-description.md'), PROSE);
  const artifactDir = await headlessPackage(path.join(taskDir, 'artifacts/recipe-runs/r1'));
  await writeFile(path.join(artifactDir, 'report.md'), 'Status: pass\nNodes: 5/5 passed\n');

  const plain = await renderTaskArtifactsMarkdown({ taskDir, artifactDir });
  assert.doesNotMatch(plain.body, /Transcript:/);

  const { body } = await renderTaskArtifactsMarkdown({ taskDir, artifactDir, transcript: true });
  const logs = body.slice(body.indexOf('## **Validation Logs**'));
  assert.match(
    logs,
    /Transcript:\n\n```\nRecipe: Permissioned dex on testnet, Core\n[\s\S]*\nArtifacts: recipe run r1 \(trace\.json, report\.md\)\n```\n\n<details><summary>Full output/,
  );
  assert.ok(body.indexOf('Transcript:') < body.indexOf('Pre-merge author checklist'));
});

async function validPackage(dir: string, traceRunner: unknown = RUNNER): Promise<string> {
  await writeJson(path.join(dir, 'recipe.json'), RECIPE);
  await writeJson(path.join(dir, 'recipe-resolution.json'), {
    schema_version: 1,
    root: { ref: '$root', digest: digestRecipeDocument(RECIPE) },
    dependencies: [],
    edges: [],
  });
  // A legacy package without a run id or claim ledger, as the existing validator fixture.
  await writeJson(path.join(dir, 'summary.json'), {
    status: 'pass',
    startedAt: '2026-05-30T15:00:00Z',
    completedAt: '2026-05-30T15:00:01Z',
    durationMs: 1000,
    total: 1,
    passed: 1,
    failed: 0,
    cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    runner: RUNNER,
  });
  await writeJson(path.join(dir, 'trace.json'), {
    metadata: { runner: traceRunner },
    entries: [{ ...entry('done', 'end', true, {}), status: 'pass' }],
  });
  await writeJson(path.join(dir, 'artifact-manifest.json'), {
    version: 1,
    runStatus: 'pass',
    provenance: { runner: RUNNER },
    artifacts: [
      { path: 'summary.json', type: 'summary' },
      { path: 'trace.json', type: 'trace' },
      { path: 'recipe.json', type: 'recipe' },
    ],
  });
  await writeFile(path.join(dir, 'report.md'), 'Status: pass\nNodes: 1/1 passed\n');
  return dir;
}

test('the transcript format renders only a validated selected attempt', async (t) => {
  const taskDir = await root(t);
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/pr-description.md'), PROSE);
  const attempt = await validPackage(path.join(taskDir, 'artifacts/recipe-runs/r2'));
  assert.equal(recordRecipeAttemptSelection(taskDir, attempt), true);

  const { result, body } = await renderRetainedArtifactsMarkdown({
    directory: taskDir,
    format: 'transcript',
  });
  assert.equal(result.artifactDir, attempt);
  assert.equal(result.transcript, body);
  assert.match(body, /^Recipe: Permissioned dex on testnet, Core\nRun not recorded · /);
  assert.match(body, /\nArtifacts: recipe run r2 \(trace\.json, report\.md\)\n$/);
  assert.equal(result.sections, undefined);

  await validPackage(attempt, { ...RUNNER, git_ref: 'other-revision' });
  await assert.rejects(
    renderRetainedArtifactsMarkdown({ directory: taskDir, format: 'transcript' }),
    /^Error: Artifact validation failed; the transcript was not rendered or written\.$/,
  );
});

test('review r1: secrets, groups, changed reports and the line cap', async (t) => {
  const base = await root(t);
  const failures = Array.from({ length: 45 }, (_, index) =>
    entry(`fail-${index}`, 'command', false, {
      exitCode: 1,
      stdout: '',
      stderr: 'curl -H x-api-key:SECRET123',
    }, { error: { message: 'Command exited with 1: deploy --password hunter2' } }),
  );
  const many = await headlessPackage(path.join(base, 'many'), failures);
  const capped = await renderRecipeTranscript({ artifactDir: many });
  assert.ok(capped.trimEnd().split('\n').length <= 40);
  assert.match(capped, /^… \d+ more nodes in trace\.json \(\d+ failed\)$/m);
  assert.doesNotMatch(capped, /SECRET123|hunter2/);
  assert.match(capped, /^✗ fail-0 {2}command {2}exit 1 · failed; details in report\.md$/m);

  const dir = await headlessPackage(path.join(base, 'groups'), [
    entry('check', 'assert_json', true, {
      path: `${REPORT_DIR}/trade.json`,
      assertion: {
        all: [
          { path: '$.ok', operator: 'eq', value: false },
          { none: [{ path: '$.missingFills', operator: 'length_gt', value: 0 }] },
          { path: '$.session.authorization', operator: 'exists' },
        ],
      },
    }),
  ]);
  await writeJson(path.join(dir, 'recipe-invocation.json'), {
    version: 1,
    params: { network: 'https://user:pass@rpc.example\nmainnet' },
    redactedPaths: [],
  });
  const text = await renderRecipeTranscript({ artifactDir: dir });
  assert.match(text, /network https:\/\/<redacted>@rpc\.example mainnet$/m);
  assert.match(text, / · not missingFills=\[0\] \(len>0\)/);
  assert.match(text, /ok=true \(=false\) ⚠ report differs from the asserted value/);
  assert.match(text, /session\.authorization="<redacted>"/);
  assert.doesNotMatch(text, /user:pass|ghp_/);
});
