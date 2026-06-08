import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ProjectVars } from '../core/config.js';

import {
  listWorkerTemplateOptions,
  normalizeTaskTemplateSelection,
  parseWorkerTemplateFileName,
  resolveWorkerTemplateSelection,
  resolveWorkerTemplateSelectionForRun,
} from './worker-template-options.js';

async function withProjectVars(fn: (vars: ProjectVars) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-template-options-'));
  try {
    const workerDir = path.join(root, 'templates', 'worker');
    await mkdir(workerDir, { recursive: true });
    await writeFile(path.join(workerDir, 'fix-bug.md'), '# Default\n', 'utf-8');
    await writeFile(path.join(workerDir, 'fix-bug-interactive.md'), '# Interactive\n', 'utf-8');
    await writeFile(path.join(workerDir, 'fix-bug-v2.md'), '# V2\n', 'utf-8');
    await writeFile(path.join(workerDir, 'dev.md'), '# Dev\n', 'utf-8');
    await writeFile(path.join(workerDir, 'dev-interactive.md'), '# Dev Interactive\n', 'utf-8');
    await writeFile(path.join(workerDir, 'pr-complete.md'), '# PR Complete\n', 'utf-8');
    await writeFile(
      path.join(workerDir, 'pr-complete-interactive.md'),
      '# PR Complete Interactive\n',
      'utf-8',
    );
    await writeFile(path.join(workerDir, 'other.md'), '# Other\n', 'utf-8');
    await fn({
      projectName: 'demo',
      projectConfig: path.join(root, 'project.json'),
      projectFixturesDir: path.join(root, 'fixtures'),
      projectTemplatesDir: path.join(root, 'templates'),
      projectJson: { name: 'demo' },
      runtimeDir: '.agent',
      artifactDir: '.task',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('parseWorkerTemplateFileName accepts canonical defaults and suffixed versions only', () => {
  assert.deepEqual(parseWorkerTemplateFileName('fix-bug', 'fix-bug.md'), {
    variant: null,
    isDefault: true,
  });
  assert.deepEqual(parseWorkerTemplateFileName('fix-bug', 'fix-bug-v2.md'), {
    variant: 'v2',
    isDefault: false,
  });
  assert.equal(parseWorkerTemplateFileName('fix-bug', 'review-pr-v2.md'), null);
  assert.equal(parseWorkerTemplateFileName('fix-bug', '../fix-bug-v2.md'), null);
  assert.equal(parseWorkerTemplateFileName('fix-bug', 'fix-bug-.hidden.md'), null);
  assert.equal(parseWorkerTemplateFileName('fix-bug', 'fix-bug-V2.md'), null);
  assert.equal(parseWorkerTemplateFileName('fix-bug', 'fix-bug-v2.txt'), null);
  assert.equal(parseWorkerTemplateFileName('fix-bug', 'fix-bug.md.bak'), null);
  assert.equal(parseWorkerTemplateFileName('fix-bug', 'fix-bug-v1..md'), null);
  assert.equal(parseWorkerTemplateFileName('fix-bug', 'fix-bug-v1-.md'), null);
});

test('listWorkerTemplateOptions returns default first then variants for one flow', async () => {
  await withProjectVars(async (vars) => {
    const options = await listWorkerTemplateOptions(vars, 'fix-bug');
    assert.deepEqual(
      options.map((option) => option.fileName),
      ['fix-bug.md', 'fix-bug-interactive.md', 'fix-bug-v2.md'],
    );
    assert.equal(options[0].isDefault, true);
    assert.equal(options[1].variant, 'interactive');
  });
});

test('resolveWorkerTemplateSelection reads the selected variant and normalizes variant', async () => {
  await withProjectVars(async (vars) => {
    const selected = await resolveWorkerTemplateSelection(vars, 'fix-bug', {
      fileName: 'fix-bug-v2.md',
    });
    assert.equal(selected.fileName, 'fix-bug-v2.md');
    assert.equal(selected.variant, 'v2');
    assert.equal(selected.content, '# V2\n');
  });
});

test('resolveWorkerTemplateSelectionForRun implicitly selects fix-bug-interactive for interactive fix-bug when present', async () => {
  await withProjectVars(async (vars) => {
    const selected = await resolveWorkerTemplateSelectionForRun(vars, 'fix-bug', 'interactive');
    assert.equal(selected.fileName, 'fix-bug-interactive.md');
    assert.equal(selected.variant, 'interactive');
    assert.equal(selected.selectionSource, 'implicit-interactive-fix-bug');
    assert.match(selected.selectionReason, /interactive mode/);
  });
});

test('parseWorkerTemplateFileName accepts dev-interactive as a dev template variant', () => {
  assert.deepEqual(parseWorkerTemplateFileName('dev', 'dev-interactive.md'), {
    variant: 'interactive',
    isDefault: false,
  });
});

test('parseWorkerTemplateFileName accepts pr-complete-interactive as a pr-complete template variant', () => {
  assert.deepEqual(parseWorkerTemplateFileName('pr-complete', 'pr-complete-interactive.md'), {
    variant: 'interactive',
    isDefault: false,
  });
});

test('resolveWorkerTemplateSelectionForRun implicitly selects dev-interactive for interactive dev when present', async () => {
  await withProjectVars(async (vars) => {
    const selected = await resolveWorkerTemplateSelectionForRun(vars, 'dev', 'interactive');
    assert.equal(selected.fileName, 'dev-interactive.md');
    assert.equal(selected.variant, 'interactive');
    assert.equal(selected.selectionSource, 'implicit-interactive-dev');
    assert.match(selected.selectionReason, /interactive mode/);
  });
});

test('resolveWorkerTemplateSelectionForRun falls back to dev.md when dev-interactive is absent', async () => {
  await withProjectVars(async (vars) => {
    await rm(path.join(vars.projectTemplatesDir, 'worker', 'dev-interactive.md'));
    const selected = await resolveWorkerTemplateSelectionForRun(vars, 'dev', 'interactive');
    assert.equal(selected.fileName, 'dev.md');
    assert.equal(selected.selectionSource, 'default');
  });
});

test('resolveWorkerTemplateSelectionForRun implicitly selects pr-complete-interactive for interactive pr-complete when present', async () => {
  await withProjectVars(async (vars) => {
    const selected = await resolveWorkerTemplateSelectionForRun(vars, 'pr-complete', 'interactive');
    assert.equal(selected.fileName, 'pr-complete-interactive.md');
    assert.equal(selected.variant, 'interactive');
    assert.equal(selected.selectionSource, 'implicit-interactive-pr-complete');
    assert.match(selected.selectionReason, /interactive mode/);
  });
});

test('resolveWorkerTemplateSelectionForRun falls back to pr-complete.md when pr-complete-interactive is absent', async () => {
  await withProjectVars(async (vars) => {
    await rm(path.join(vars.projectTemplatesDir, 'worker', 'pr-complete-interactive.md'));
    const selected = await resolveWorkerTemplateSelectionForRun(vars, 'pr-complete', 'interactive');
    assert.equal(selected.fileName, 'pr-complete.md');
    assert.equal(selected.selectionSource, 'default');
  });
});

test('resolveWorkerTemplateSelectionForRun keeps explicit invalid selections loud', async () => {
  await withProjectVars(async (vars) => {
    await assert.rejects(
      () =>
        resolveWorkerTemplateSelectionForRun(vars, 'dev', 'interactive', {
          fileName: 'fix-bug.md',
        }),
      /does not match/,
    );
  });
});

test('normalizeTaskTemplateSelection rejects paths and flow mismatches', () => {
  assert.throws(
    () => normalizeTaskTemplateSelection('fix-bug', { fileName: '../fix-bug-v2.md' }),
    /basename/,
  );
  assert.throws(
    () => normalizeTaskTemplateSelection('fix-bug', { fileName: 'dev-v2.md' }),
    /does not match/,
  );
});
