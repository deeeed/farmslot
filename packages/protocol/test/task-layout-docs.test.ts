import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { taskLayoutDocIssues } from '../scripts/check-task-layout-docs.mjs';
import { TASK_DIRECTORY_LAYOUT } from '../src/task-layout.js';

const paths = (text: string) => taskLayoutDocIssues(text).map(({ relativePath }) => relativePath);

test('documented canonical task actions and attempt placeholders match the contract', () => {
  assert.deepEqual(
    paths(
      'Keep `<task>/artifacts/task-actions/manifests/` and `<task>/artifacts/task-actions/actions/`.\nUse `<task>/artifacts/recipe-runs/<attempt>/`.',
    ),
    [],
  );
});

test('wrong task-action roots fail in Markdown, HTML and template variables', () => {
  for (const text of [
    '`<task>/task-actions/manifests/`',
    '<code>&lt;task&gt;/task-actions/actions/</code>',
    '{{TASK_DIR}}/task-actions/actions/example.mjs',
    '${TASK_DIR}/task-actions/actions/example.mjs',
    '`task-actions/manifests/`',
  ])
    assert.ok(
      paths(text).some((entry) => entry.startsWith('task-actions/')),
      text,
    );
});

test('an indented HTML task tree catches singular recipe-run instead of accepting artifacts wholesale', () => {
  const text =
    '<pre><code>&lt;task&gt;/\n  artifacts/\n    recipe.json, recipe-run/      authored recipe and immutable run package</code></pre>';
  assert.deepEqual(paths(text), ['artifacts/recipe-run']);
  assert.deepEqual(paths(text.replace('recipe-run/', 'recipe-runs/')), []);
});

test('unknown paths fail even beneath a known collection directory', () => {
  assert.deepEqual(paths('Write `<task>/inputs/wrong.json` and `artifacts/recipe-rnus/`.'), [
    'inputs/wrong.json',
    'artifacts/recipe-rnus',
  ]);
});

test('documented baseline directories require exact names', () => {
  assert.deepEqual(paths('run --artifacts-dir <task>/artifacts/recipe-baseline-run --json'), []);
  assert.deepEqual(paths('Use `<task>/artifacts/recipe-baseline-run-3`.'), [
    'artifacts/recipe-baseline-run-3',
  ]);
});

test('product paths, URLs and sibling scratch work are outside the task directory', () => {
  assert.deepEqual(
    paths(
      'See `src/task-actions/` or https://example.test/task-actions/. Put scratch at `<task>/../scratch-<id>`.',
    ),
    [],
  );
});

test('canonical HTML paths and brace-expanded subdirectories are checked individually', () => {
  assert.deepEqual(
    paths('<code>&lt;task&gt;/artifacts/task-actions/{manifests,actions}/</code>'),
    [],
  );
  assert.deepEqual(paths('`<task>/artifacts/task-actions/{manifests,wrong}/`'), [
    'artifacts/task-actions/wrong',
  ]);
});

test('even an explicit diagnostic output needs an exact contract entry', () => {
  assert.deepEqual(paths('run --artifacts-dir <task>/artifacts/unregistered-baseline --json'), [
    'artifacts/unregistered-baseline',
  ]);
});

test('bare HTML task-relative paths are checked outside the layout tree too', () => {
  assert.deepEqual(paths('<code>artifacts/recipe-runs/</code>'), []);
  assert.deepEqual(paths('<code>artifacts/recipe-rnus/</code>'), ['artifacts/recipe-rnus']);
});

test('the consumer command fails on real input drift and on missing documentation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-layout-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/check-task-layout-docs.mjs', import.meta.url));
  const file = path.join(root, 'task-dir.html');
  await writeFile(file, '<code>artifacts/recipe-runs/</code>');
  assert.equal(spawnSync(process.execPath, [script, file]).status, 0);
  await writeFile(file, '<code>artifacts/recipe-run/</code>');
  const refused = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /task-dir.html:1: undefined task path artifacts\/recipe-run/);
  assert.notEqual(spawnSync(process.execPath, [script, path.join(root, 'absent.md')]).status, 0);
});

test('every contract entry records its purpose', () => {
  for (const [name, entry] of Object.entries(TASK_DIRECTORY_LAYOUT)) {
    assert.ok(entry.purpose.trim().length > 0, name);
  }
});

test('known task filenames cannot hide under an unrecognized parent directory', () => {
  assert.deepEqual(paths('Use `imputs/handoff.json` and `archive/report.html`.'), [
    'imputs/handoff.json',
    'archive/report.html',
  ]);
  assert.deepEqual(
    paths('See `<repo>/archive/report.html` or `https://example.test/report.html`.'),
    [],
  );
});
