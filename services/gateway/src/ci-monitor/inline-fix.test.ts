import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../core/config.js';

import { resolveCiFixTemplatePath } from './inline-fix.js';

test('resolveCiFixTemplatePath prefers project-owned ci-fix.md', async () => {
  const project = `ci-fix-test-${Date.now()}`;
  const projectDir = path.join(farmslotRoot, 'projects', project, 'templates', 'worker');
  await mkdir(projectDir, { recursive: true });
  const projectTemplate = path.join(projectDir, 'ci-fix.md');
  await writeFile(projectTemplate, '# test\n', 'utf-8');
  try {
    const resolved = await resolveCiFixTemplatePath(project);
    assert.equal(resolved, projectTemplate);
  } finally {
    await rm(path.join(farmslotRoot, 'projects', project), { recursive: true, force: true });
  }
});

test('resolveCiFixTemplatePath falls back to Farmslot default template', async () => {
  const resolved = await resolveCiFixTemplatePath('__missing-project-for-ci-fix-test__');
  assert.equal(resolved, path.join(farmslotRoot, 'templates', 'worker', 'ci-fix.md'));
});

test('default CI fix template uses explicit CI-FIX marker targeting', async () => {
  const template = await readFile(
    path.join(farmslotRoot, 'templates', 'worker', 'ci-fix.md'),
    'utf-8',
  );

  assert.match(template, /mark --checklist CI-FIX\.md start/);
  assert.match(template, /mark --checklist CI-FIX\.md 1/);
  assert.match(template, /mark --checklist CI-FIX\.md complete --mark-last/);
  assert.doesNotMatch(template, /mark start/);
  assert.doesNotMatch(template, /mark complete \|/);
  assert.doesNotMatch(template, /mark-checklist-step\.cjs .*CI-FIX\.md .*CI-FIX-SIGNAL\.json/);
});

test('default CI fix template completion marker writes CI-FIX signal', async () => {
  const templatePath = path.join(farmslotRoot, 'templates', 'worker', 'ci-fix.md');
  const template = await readFile(templatePath, 'utf-8');
  const taskDir = await mkdtemp(path.join(tmpdir(), 'farmslot-ci-fix-mark-'));
  const marker = path.join(
    farmslotRoot,
    'packages',
    'agent-runtime',
    'scripts',
    'mark-checklist-step.cjs',
  );

  try {
    await writeFile(path.join(taskDir, 'CI-FIX.md'), template, 'utf-8');
    await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
    await writeFile(path.join(taskDir, 'artifacts', 'report.md'), '# CI fix report\n', 'utf-8');
    await writeFile(
      path.join(taskDir, 'artifacts', 'learnings.md'),
      '- Regression covered.\n',
      'utf-8',
    );

    const runMarker = (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [marker, taskDir, '--checklist', 'CI-FIX.md', ...args],
        {
          encoding: 'utf-8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
    };

    runMarker('start');
    const checklistItemCount = template.match(/^\s*-\s+\[ \]/gm)?.length ?? 0;
    assert.ok(checklistItemCount > 0, 'expected CI-FIX.md checklist items');
    for (let step = 1; step <= checklistItemCount; step += 1) {
      runMarker(String(step));
    }
    runMarker('complete', '--mark-last');

    const signal = JSON.parse(await readFile(path.join(taskDir, 'CI-FIX-SIGNAL.json'), 'utf-8'));
    assert.equal(signal.status, 'complete');
    assert.equal(signal.outcome, 'success');
    assert.equal(signal.checklistTiming.source, 'CI-FIX.md');
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});
