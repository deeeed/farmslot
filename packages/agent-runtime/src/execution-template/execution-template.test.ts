import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createExecutionTemplate } from './create.js';
import {
  inferFlowFromBasename,
  inferRunModeFromBasename,
  inferTemplateMetadata,
  legacyWorkerTemplateId,
} from './infer.js';
import { lintExecutionTemplates } from './lint.js';
import {
  customTemplateSource,
  listExecutionTemplates,
  packageFlowTreeTemplateSource,
  projectWorkerTemplateSource,
} from './resolve.js';

function withTemp(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'farmslot-exec-tpl-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('inferFlowFromBasename uses longest Farmslot flow prefix', () => {
  assert.equal(inferFlowFromBasename('fix-bug-autonomous.mobile.md'), 'fix-bug');
  assert.equal(inferFlowFromBasename('pr-complete-interactive.md'), 'pr-complete');
  assert.equal(inferFlowFromBasename('dev.md'), 'dev');
  assert.equal(inferFlowFromBasename('review-pr.md'), 'review-pr');
  assert.equal(inferFlowFromBasename('notes.md'), null);
});

test('inferRunModeFromBasename maps legacy and mode tokens', () => {
  assert.equal(inferRunModeFromBasename('dev.md'), 'autonomous');
  assert.equal(inferRunModeFromBasename('dev-interactive.md'), 'interactive');
  assert.equal(inferRunModeFromBasename('dev-autonomous.mobile.md'), 'autonomous');
  assert.equal(inferRunModeFromBasename('fix-bug-interactive.extension.md'), 'interactive');
});

test('legacyWorkerTemplateId preserves ADR compatibility ids', () => {
  assert.equal(legacyWorkerTemplateId('dev.md'), 'legacy-dev-default');
  assert.equal(legacyWorkerTemplateId('dev-interactive.md'), 'legacy-dev-interactive');
  assert.equal(legacyWorkerTemplateId('fix-bug.md'), 'legacy-fix-bug-default');
});

test('inferTemplateMetadata prefers frontmatter then filename/heading', () => {
  const meta = inferTemplateMetadata({
    absolutePath: '/tmp/dev-autonomous.mobile.md',
    relativePath: 'dev/dev-autonomous.mobile.md',
    source: {
      id: 'package:recipe-cook',
      kind: 'package',
      root: '/tmp',
      layout: 'flow-tree',
    },
    text: `---
id: custom-dev-mobile
title: Custom Dev
runMode: autonomous
platforms: [mobile]
version: 2
---

# Ignored heading

- [ ] Do the work
`,
  });
  assert.equal(meta.id, 'custom-dev-mobile');
  assert.equal(meta.title, 'Custom Dev');
  assert.equal(meta.flow, 'dev');
  assert.equal(meta.version, '2');
  assert.equal(meta.runMode, 'autonomous');
  assert.deepEqual(meta.platforms, ['mobile']);
});

test('listExecutionTemplates reports shadowing across project and package sources', () => {
  withTemp((root) => {
    const projectWorker = join(root, 'project', 'templates', 'worker');
    const packageTpl = join(root, 'skills', 'templates');
    mkdirSync(projectWorker, { recursive: true });
    mkdirSync(join(packageTpl, 'dev'), { recursive: true });

    writeFileSync(join(projectWorker, 'dev.md'), '# Legacy Dev\n\n- [ ] Farm step\n', 'utf8');
    // Same explicit id as legacy mapping would not collide; create a colliding id via frontmatter.
    writeFileSync(
      join(packageTpl, 'dev', 'dev-autonomous.mobile.md'),
      `---
id: legacy-dev-default
runMode: autonomous
platforms: [mobile]
---

# Shared Dev

- [ ] Shared step
`,
      'utf8',
    );

    const entries = listExecutionTemplates({
      sources: [
        projectWorkerTemplateSource('metamask-mobile-farm', join(root, 'project', 'templates')),
        packageFlowTreeTemplateSource('recipe-cook', packageTpl),
      ],
      includeShadowed: true,
    });

    const winners = entries.filter((e) => !e.shadowedBy && e.id === 'legacy-dev-default');
    const shadowed = entries.filter((e) => e.shadowedBy && e.id === 'legacy-dev-default');
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.sourceKind, 'project');
    assert.equal(shadowed.length, 1);
    assert.equal(shadowed[0]?.sourceKind, 'package');
    assert.equal(shadowed[0]?.shadowedBy, 'project:metamask-mobile-farm');
  });
});

test('lintExecutionTemplates accepts valid checkboxes and rejects fix-ticket / bad boxes', () => {
  withTemp((root) => {
    const ok = join(root, 'dev-autonomous.mobile.md');
    writeFileSync(ok, '# Ok\n\n- [ ] one\n- [x] two\n', 'utf8');
    const okResult = lintExecutionTemplates(ok);
    assert.equal(okResult.ok, true);

    const bad = join(root, 'dev-bad.md');
    writeFileSync(bad, '# Bad\n\n- [?] broken\nfix-ticket leftover\n', 'utf8');
    const badResult = lintExecutionTemplates(bad);
    assert.equal(badResult.ok, false);
    assert.ok(badResult.issues.some((i) => /fix-ticket/.test(i.message)));
    assert.ok(badResult.issues.some((i) => /checkbox/.test(i.message)));
  });
});

test('createExecutionTemplate writes lint-clean starter with optional frontmatter', () => {
  withTemp((root) => {
    const target = join(root, 'dev', 'dev-autonomous.mobile.md');
    const created = createExecutionTemplate({
      path: target,
      runMode: 'autonomous',
      platforms: ['mobile'],
    });
    assert.equal(created.created, true);
    const text = readFileSync(target, 'utf8');
    assert.match(text, /runMode: autonomous/);
    assert.match(text, /platforms: \[mobile\]/);
    assert.match(text, /- \[ \] Read the task prompt/);
    assert.equal(lintExecutionTemplates(target).ok, true);
  });
});

test('custom source outranks package source for the same id', () => {
  withTemp((root) => {
    const custom = join(root, 'custom');
    const pkg = join(root, 'pkg');
    mkdirSync(join(custom, 'dev'), { recursive: true });
    mkdirSync(join(pkg, 'dev'), { recursive: true });
    const body = (label: string) => `---\nid: shared-dev\n---\n\n# ${label}\n\n- [ ] step\n`;
    writeFileSync(join(custom, 'dev', 'dev-autonomous.mobile.md'), body('custom'), 'utf8');
    writeFileSync(join(pkg, 'dev', 'dev-autonomous.mobile.md'), body('package'), 'utf8');

    const entries = listExecutionTemplates({
      sources: [
        packageFlowTreeTemplateSource('recipe-cook', pkg),
        customTemplateSource('overlay', custom),
      ],
    });
    const winner = entries.find((e) => e.id === 'shared-dev' && !e.shadowedBy);
    assert.equal(winner?.sourceKind, 'custom');
    assert.equal(winner?.title, 'custom');
  });
});
