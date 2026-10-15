import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { renderTaskArtifactsMarkdown } from '../src/harness/commands/artifacts-markdown.js';

const PROSE =
  '## **Description**\n\nAuthored explanation.\n\n## **Screenshots/Recordings**\n\n![after](after.png)\n\n## **Pre-merge author checklist**\n\n- [x] Guidelines\n';
const RECIPE = {
  title: 'Order form proof',
  workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
};

async function task(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifacts-markdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'artifacts/pr-description.md'), PROSE);
  return root;
}

test('static tasks retain authored prose and checklist with explicit N/A sections', async (t) => {
  const taskDir = await task(t);
  const result = await renderTaskArtifactsMarkdown({ taskDir });
  assert.match(result.body, /Authored explanation\./);
  assert.match(result.body, /!\[after\]\(after.png\)/);
  assert.match(result.body, /Not applicable: this task has no `artifacts\/recipe.json`/);
  assert.match(result.body, /Not applicable: no recipe run report/);
  assert.ok(
    result.body.indexOf('Validation Logs') < result.body.indexOf('Pre-merge author checklist'),
  );
  assert.match(result.body, /- \[x\] Guidelines\n$/);
  assert.equal(result.recipe, null);
  assert.equal(result.run, null);
});

test('replaces pasted machine sections behind broken fences while preserving authored sections', async (t) => {
  const taskDir = await task(t);
  await writeFile(
    path.join(taskDir, 'artifacts/pr-description.md'),
    `${PROSE}\n## **Validation Recipe**\n\n\`\`\`json\nOLD_RECIPE\n\n## **Validation Logs**\n\nOLD_LOG\n\n## **Recipe Workflow**\nOLD_WORKFLOW\n`,
  );
  const result = await renderTaskArtifactsMarkdown({ taskDir });
  assert.doesNotMatch(result.body, /OLD_/);
  assert.equal(result.body.match(/## \*\*Validation Recipe\*\*/g)?.length, 1);
  assert.equal(result.body.match(/## \*\*Validation Logs\*\*/g)?.length, 1);
  assert.deepEqual(result.sections, ['## **Validation Recipe**', '## **Validation Logs**']);
});

test('uses the resolved attempt recipe and report without reselecting or reading stale drafts', async (t) => {
  const taskDir = await task(t);
  const artifactDir = path.join(taskDir, 'artifacts/recipe-runs/selected');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/recipe.json'), '{malformed mutable draft');
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    '{changed after selection',
  );
  await writeFile(path.join(artifactDir, 'recipe.json'), JSON.stringify(RECIPE));
  await writeFile(
    path.join(artifactDir, 'summary.json'),
    JSON.stringify({
      recipeRunId: 'recorded-run',
      runner: { name: 'fixture', git_ref: 'reviewed-revision', source: '/private/runner/source' },
    }),
  );
  await writeFile(
    path.join(artifactDir, 'recipe-resolution.json'),
    JSON.stringify({ root: { digest: 'retained-digest' } }),
  );
  await writeFile(
    path.join(artifactDir, 'report.md'),
    'Status: pass\r\nNodes: 1/1 passed\r\n\r\nCURRENT ``` tricky\n',
  );
  const result = await renderTaskArtifactsMarkdown({
    taskDir,
    artifactDir,
    command: 'farmslot recipe run task/recipe.json',
  });
  assert.deepEqual(result.recipe, { nodes: 1, path: 'artifacts/recipe-runs/selected/recipe.json' });
  assert.deepEqual(result.run, { path: 'artifacts/recipe-runs/selected/report.md' });
  assert.match(result.body, /Full output \(1\/1 passed, pass\)/);
  assert.match(result.body, /```bash\nfarmslot recipe run task\/recipe.json\n```/);
  assert.match(result.body, /````\nStatus: pass\n/);
  assert.doesNotMatch(result.body, /\r|mutable draft/);
  assert.match(result.body, /Run: recorded-run/);
  assert.match(result.body, /Runner revision: reviewed-revision/);
  assert.match(result.body, /Recipe digest: retained-digest/);
  assert.doesNotMatch(result.body, /\/private\/|recipe-runs\/selected/);
});

test('escapes titles and renders the optional workflow with safe fences', async (t) => {
  const taskDir = await task(t);
  await writeFile(
    path.join(taskDir, 'artifacts/recipe.json'),
    JSON.stringify({ ...RECIPE, title: '</summary><!--' }),
  );
  await writeFile(path.join(taskDir, 'artifacts/workflow.mmd'), 'flowchart TD\n  a --> b\n');
  const result = await renderTaskArtifactsMarkdown({ taskDir });
  assert.match(result.body, /&lt;\/summary&gt;&lt;!--/);
  assert.match(result.body, /```mermaid\nflowchart TD\n {2}a --> b\n```/);
  assert.deepEqual(result.workflow, { path: 'artifacts/workflow.mmd' });
});

test('preserves older array recipe node counts and appends without a checklist', async (t) => {
  const taskDir = await task(t);
  await writeFile(path.join(taskDir, 'artifacts/pr-description.md'), '## Summary\n\nAuthored.\n');
  for (const [document, nodes] of [
    [{ workflow: { setup: [1], main: [2, 3] } }, 3],
    [{ nodes: [1, 2] }, 2],
    [{ steps: [1] }, 1],
    [{}, 0],
  ] as const) {
    await writeFile(path.join(taskDir, 'artifacts/recipe.json'), JSON.stringify(document));
    const result = await renderTaskArtifactsMarkdown({ taskDir });
    assert.equal(result.recipe?.nodes, nodes);
    assert.ok(result.body.startsWith('## Summary\n\nAuthored.\n\n## **Validation Recipe**'));
  }
});

test('refuses symlinked source artifacts instead of reading foreign prose', async (t) => {
  const taskDir = await task(t);
  const prose = path.join(taskDir, 'artifacts/pr-description.md');
  await rm(prose);
  await symlink(path.join(taskDir, 'foreign.md'), prose);
  await writeFile(path.join(taskDir, 'foreign.md'), 'Foreign description');
  await assert.rejects(renderTaskArtifactsMarkdown({ taskDir }), /symbolic link/);
  assert.equal(await readFile(path.join(taskDir, 'foreign.md'), 'utf8'), 'Foreign description');
});

test('missing description names the authored input and writes nothing', async (t) => {
  const taskDir = await task(t);
  await rm(path.join(taskDir, 'artifacts/pr-description.md'));
  await assert.rejects(
    renderTaskArtifactsMarkdown({ taskDir }),
    /Missing artifacts\/pr-description.md/,
  );
});

test('an incomplete selected report refuses instead of rendering the older report', async (t) => {
  const taskDir = await task(t);
  const artifactDir = path.join(taskDir, 'artifacts/recipe-runs/incomplete');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'recipe.json'), JSON.stringify(RECIPE));
  await mkdir(path.join(taskDir, 'artifacts/recipe-run'));
  await writeFile(path.join(taskDir, 'artifacts/recipe-run/report.md'), 'OLD_REPORT');
  await assert.rejects(
    renderTaskArtifactsMarkdown({ taskDir, artifactDir }),
    /must contain its captured recipe and report/,
  );
});
