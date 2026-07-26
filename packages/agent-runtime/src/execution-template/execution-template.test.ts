import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createExecutionTemplate } from './create.js';
import { parseMarkdownDocument } from './frontmatter.js';
import {
  catalogRelativeId,
  inferFlowFromBasename,
  inferRunModeFromBasename,
  inferTemplateMetadata,
} from './infer.js';
import { lintExecutionTemplates, lintExecutionTemplateText } from './lint.js';
import {
  listProjectWorkerTemplateOptions,
  resolveProjectWorkerTemplateForRun,
} from './project-worker.js';
import {
  customTemplateSource,
  listExecutionTemplates,
  packageFlowTreeTemplateSource,
  projectWorkerTemplateSource,
} from './resolve.js';
import { selectExecutionTemplate } from './select.js';
import {
  executionTemplateReference,
  materializeExecutionTemplate,
  sha256Text,
} from './snapshot.js';
import { resolveConfiguredExecutionTemplateSources } from './source-config.js';

function withTemp(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'farmslot-exec-tpl-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'farmslot-exec-tpl-'));
  try {
    await fn(root);
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

test('inferRunModeFromBasename resolves only explicit mode tokens', () => {
  // A bare flow name encodes no mode — review-pr/update-branch run interactive
  // as often as autonomous, so nothing may default here.
  assert.equal(inferRunModeFromBasename('dev.md'), null);
  assert.equal(inferRunModeFromBasename('review-pr.md'), null);
  assert.equal(inferRunModeFromBasename('dev-interactive.md'), 'interactive');
  assert.equal(inferRunModeFromBasename('dev-autonomous.mobile.md'), 'autonomous');
  assert.equal(inferRunModeFromBasename('fix-bug-interactive.extension.md'), 'interactive');
});

test('self-review-fix resolves as its own prefix, not self-review', () => {
  assert.equal(inferFlowFromBasename('self-review-fix.md'), 'self-review-fix');
  assert.equal(inferFlowFromBasename('self-review.md'), 'self-review');
});

test('catalog ids collide across worker-flat and flow-tree layouts', () => {
  // Precedence/shadowing is keyed on id — a project worker-flat override and a
  // package flow-tree base MUST normalize to the same id.
  assert.equal(catalogRelativeId('fix-bug.core.md', 'worker-flat'), 'fix-bug/core');
  assert.equal(catalogRelativeId('fix-bug/core.md', 'flow-tree'), 'fix-bug/core');
  assert.equal(catalogRelativeId('dev.md', 'worker-flat'), 'dev/default');
  assert.equal(catalogRelativeId('dev-interactive.md', 'worker-flat'), 'dev/interactive');
  assert.equal(catalogRelativeId('notes.md', 'worker-flat'), 'notes');
});

test('shared project-worker selector preserves no-config option ordering', async () => {
  await withTempAsync(async (root) => {
    const worker = join(root, 'templates', 'worker');
    mkdirSync(worker, { recursive: true });
    writeFileSync(join(worker, 'fix-bug-v2.md'), '# V2\n');
    writeFileSync(join(worker, 'fix-bug.md'), '# Default\n');
    writeFileSync(join(worker, 'fix-bug-interactive.md'), '# Interactive\n');
    writeFileSync(join(worker, 'dev.md'), '# Other flow\n');

    const options = await listProjectWorkerTemplateOptions(join(root, 'templates'), 'fix-bug');
    assert.deepEqual(
      options.map((option) => option.fileName),
      ['fix-bug.md', 'fix-bug-interactive.md', 'fix-bug-v2.md'],
    );
    assert.equal(options[0]?.isDefault, true);
    assert.equal(options[1]?.variant, 'interactive');
  });
});

test('shared project-worker selector preserves explicit, interactive, domain, and fallback precedence', async () => {
  await withTempAsync(async (root) => {
    const templates = join(root, 'templates');
    const worker = join(templates, 'worker');
    mkdirSync(worker, { recursive: true });
    writeFileSync(join(worker, 'fix-bug.md'), '# Default\n');
    writeFileSync(join(worker, 'fix-bug-interactive.md'), '# Interactive\n');
    writeFileSync(join(worker, 'fix-bug-trading.md'), '# Trading\n');
    writeFileSync(join(worker, 'fix-bug-v2.md'), '# Explicit\n');

    const explicit = await resolveProjectWorkerTemplateForRun(
      templates,
      'fix-bug',
      'interactive',
      { fileName: 'fix-bug-v2.md' },
      'trading',
    );
    assert.equal(explicit.fileName, 'fix-bug-v2.md');
    assert.equal(explicit.selectionSource, 'explicit');

    const interactive = await resolveProjectWorkerTemplateForRun(
      templates,
      'fix-bug',
      'interactive',
      null,
      'trading',
    );
    assert.equal(interactive.fileName, 'fix-bug-interactive.md');
    assert.equal(interactive.selectionSource, 'implicit-interactive-fix-bug');

    const domain = await resolveProjectWorkerTemplateForRun(
      templates,
      'fix-bug',
      'autonomous',
      null,
      'trading',
    );
    assert.equal(domain.fileName, 'fix-bug-trading.md');
    assert.equal(domain.selectionSource, 'implicit-domain');

    const fallback = await resolveProjectWorkerTemplateForRun(
      templates,
      'fix-bug',
      'autonomous',
      null,
      'payments',
    );
    assert.equal(fallback.fileName, 'fix-bug.md');
    assert.equal(fallback.content, '# Default\n');
    assert.equal(fallback.selectionSource, 'default');
  });
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
  assert.equal(
    meta.sha256,
    sha256Text(`---
id: custom-dev-mobile
title: Custom Dev
runMode: autonomous
platforms: [mobile]
version: 2
---

# Ignored heading

- [ ] Do the work
`),
  );
});

test('source domains add exact domain labels without removing frontmatter labels', () => {
  const meta = inferTemplateMetadata({
    absolutePath: '/tmp/fix-bug/mobile.md',
    relativePath: 'fix-bug/mobile.md',
    source: {
      id: 'team:trading',
      kind: 'workspace',
      root: '/tmp',
      layout: 'flow-tree',
      domains: ['trading'],
    },
    text: '---\nlabels: [runtime-proof]\n---\n\n# Proof\n\n- [ ] Run\n',
  });
  assert.deepEqual(meta.labels, ['runtime-proof', 'domain:trading']);
});

test('standalone domain filters keep general and exact-domain templates only', () => {
  withTemp((root) => {
    const generalRoot = join(root, 'general');
    const tradingRoot = join(root, 'trading');
    const paymentsRoot = join(root, 'payments');
    for (const sourceRoot of [generalRoot, tradingRoot, paymentsRoot]) {
      mkdirSync(join(sourceRoot, 'fix-bug'), { recursive: true });
      writeFileSync(join(sourceRoot, 'fix-bug', 'mobile.md'), '# Proof\n\n- [ ] Run\n');
    }
    const trading = packageFlowTreeTemplateSource('trading', tradingRoot);
    trading.kind = 'workspace';
    trading.domains = ['trading'];
    const payments = packageFlowTreeTemplateSource('payments', paymentsRoot);
    payments.kind = 'workspace';
    payments.domains = ['payments'];

    const entries = listExecutionTemplates({
      sources: [packageFlowTreeTemplateSource('general', generalRoot), trading, payments],
      domain: 'trading',
    });
    assert.deepEqual(entries.map((entry) => entry.sourceId).sort(), [
      'package:general',
      'package:trading',
    ]);
  });
});

test('configured selection treats missing mode as compatible without ranking it above exact mode', () => {
  withTemp((root) => {
    const source = join(root, 'catalog');
    mkdirSync(join(source, 'dev'), { recursive: true });
    writeFileSync(join(source, 'dev', 'general.mobile.md'), '# General\n\n- [ ] Run\n');
    writeFileSync(
      join(source, 'dev', 'autonomous.mobile.md'),
      '---\nrunMode: autonomous\n---\n\n# Exact\n\n- [ ] Run\n',
    );
    const sources = [packageFlowTreeTemplateSource('catalog', source)];

    assert.equal(
      listExecutionTemplates({ sources, runMode: 'autonomous' }).some(
        (entry) => entry.id === 'dev/general.mobile',
      ),
      true,
    );

    assert.throws(
      () =>
        selectExecutionTemplate({
          sources,
          flow: 'dev',
          platform: 'mobile',
          runMode: 'autonomous',
        }),
      /ambiguous/,
    );

    const explicit = selectExecutionTemplate({
      sources,
      flow: 'dev',
      platform: 'mobile',
      runMode: 'autonomous',
      explicitId: 'dev/autonomous.mobile',
    });
    assert.equal(explicit.entry.title, 'Exact');
    assert.equal(explicit.reason, 'explicit');
  });
});

test('configured selection prefers one exact-domain candidate before a general candidate', () => {
  withTemp((root) => {
    const generalRoot = join(root, 'general');
    const tradingRoot = join(root, 'trading');
    mkdirSync(join(generalRoot, 'fix-bug'), { recursive: true });
    mkdirSync(join(tradingRoot, 'fix-bug'), { recursive: true });
    writeFileSync(join(generalRoot, 'fix-bug', 'mobile.md'), '# General\n\n- [ ] Run\n');
    writeFileSync(join(tradingRoot, 'fix-bug', 'mobile.md'), '# Trading\n\n- [ ] Run\n');

    const tradingSource = packageFlowTreeTemplateSource('trading', tradingRoot);
    tradingSource.kind = 'workspace';
    tradingSource.domains = ['trading'];
    const selected = selectExecutionTemplate({
      sources: [packageFlowTreeTemplateSource('canonical', generalRoot), tradingSource],
      flow: 'fix-bug',
      platform: 'mobile',
      runMode: 'autonomous',
      domain: 'trading',
    });
    assert.equal(selected.entry.sourceId, 'package:trading');
    assert.equal(selected.reason, 'single-domain-candidate');

    const fallback = selectExecutionTemplate({
      sources: [packageFlowTreeTemplateSource('canonical', generalRoot), tradingSource],
      flow: 'fix-bug',
      platform: 'mobile',
      runMode: 'autonomous',
      domain: 'payments',
    });
    assert.equal(fallback.entry.sourceId, 'package:canonical');
    assert.equal(fallback.reason, 'single-general-candidate');

    assert.equal(
      listExecutionTemplates({ sources: [tradingSource] })[0]?.labels.includes('domain:trading'),
      true,
    );
  });
});

test('configured defaults are ordered and incompatible targets fail instead of falling through', () => {
  withTemp((root) => {
    const source = join(root, 'catalog');
    mkdirSync(join(source, 'fix-bug'), { recursive: true });
    writeFileSync(join(source, 'fix-bug', 'mobile.md'), '# Mobile\n\n- [ ] Run\n');
    writeFileSync(join(source, 'fix-bug', 'default.extension.md'), '# Extension\n\n- [ ] Run\n');
    const sources = [packageFlowTreeTemplateSource('catalog', source)];

    const selected = selectExecutionTemplate({
      sources,
      flow: 'fix-bug',
      platform: 'mobile',
      runMode: 'autonomous',
      defaults: [
        { when: { flow: 'fix-bug' }, templateId: 'fix-bug/mobile' },
        { when: { platform: 'mobile' }, templateId: 'fix-bug/default.extension' },
      ],
    });
    assert.equal(selected.entry.id, 'fix-bug/mobile');
    assert.equal(selected.reason, 'configured-default');

    assert.throws(
      () =>
        selectExecutionTemplate({
          sources,
          flow: 'fix-bug',
          platform: 'mobile',
          runMode: 'autonomous',
          defaults: [
            { when: { flow: 'fix-bug' }, templateId: 'fix-bug/default.extension' },
            { when: { platform: 'mobile' }, templateId: 'fix-bug/mobile' },
          ],
        }),
      /default "fix-bug\/default\.extension" is missing or incompatible/,
    );
  });
});

test('portable reference hashes source and rendered Markdown without absolute paths', () => {
  const source = '# Source\n\n- [ ] {{task}}\n';
  const entry = inferTemplateMetadata({
    absolutePath: '/private/machine/catalog/dev/mobile.md',
    relativePath: 'dev/mobile.md',
    source: {
      id: 'package:canonical',
      kind: 'package',
      root: '/private/machine/catalog',
      layout: 'flow-tree',
      sourceRevision: 'abc123',
    },
    text: source,
  });
  const reference = executionTemplateReference(entry, '# Source\n\n- [ ] prove it\n');
  assert.equal(reference.sha256, sha256Text(source));
  assert.equal(reference.renderedSha256, sha256Text('# Source\n\n- [ ] prove it\n'));
  assert.equal(reference.sourceRevision, 'abc123');
  assert.equal(reference.relativePath, 'dev/mobile.md');
  assert.equal('path' in reference, false);
  assert.equal(reference.version, undefined);
});

test('materializeExecutionTemplate copies one immutable snapshot and records its digest', () => {
  withTemp((root) => {
    const templates = join(root, 'templates');
    const sourcePath = join(templates, 'dev', 'autonomous.mobile.md');
    const outputPath = join(root, 'task', 'CHECKLIST.md');
    mkdirSync(join(templates, 'dev'), { recursive: true });
    writeFileSync(sourcePath, '# Mobile proof\n\n- [ ] Validate it.\n');
    const [entry] = listExecutionTemplates({
      sources: [packageFlowTreeTemplateSource('canonical', templates)],
    });
    assert.ok(entry);

    const result = materializeExecutionTemplate(entry, outputPath);
    assert.equal(readFileSync(outputPath, 'utf8'), '# Mobile proof\n\n- [ ] Validate it.\n');
    assert.equal(result.reference.sha256, result.reference.renderedSha256);
    assert.equal('path' in result.reference, false);
    assert.throws(
      () => materializeExecutionTemplate(entry, outputPath),
      /destination already exists/,
    );
  });
});

test('configured sources resolve lazily and constrain subpaths below their root', () => {
  withTemp((root) => {
    const projectPack = join(root, 'project-pack');
    const library = join(root, 'library');
    const outside = join(root, 'outside');
    mkdirSync(join(projectPack, 'local', 'checklists', 'dev'), { recursive: true });
    mkdirSync(join(library, 'checklists', 'dev'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(library, 'escaped'));

    const result = resolveConfiguredExecutionTemplateSources(
      {
        sources: [
          {
            id: 'project:local',
            kind: 'workspace',
            root: { projectPath: 'local' },
            subpath: 'checklists',
          },
          {
            id: 'team:available',
            kind: 'package',
            root: { env: 'TEAM_ROOT' },
            subpath: 'checklists',
          },
          {
            id: 'team:unset',
            kind: 'package',
            root: { env: 'UNSET_ROOT' },
          },
          {
            id: 'team:escaped',
            kind: 'package',
            root: { env: 'TEAM_ROOT' },
            subpath: 'escaped',
          },
        ],
      },
      {
        projectPackRoot: projectPack,
        env: { TEAM_ROOT: library },
      },
    );

    assert.deepEqual(
      result.sources.map((source) => source.id),
      ['project:local', 'team:available'],
    );
    assert.deepEqual(result.unavailable, [
      { id: 'team:unset', reason: 'missing-environment' },
      { id: 'team:escaped', reason: 'invalid-root' },
    ]);
  });
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
id: dev/default
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

    const winners = entries.filter((e) => !e.shadowedBy && e.id === 'dev/default');
    const shadowed = entries.filter((e) => e.shadowedBy && e.id === 'dev/default');
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

test('shadowing resolves before filters — a filtered winner still shadows its duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'et-filter-'));
  try {
    mkdirSync(join(dir, 'proj', 'worker'), { recursive: true });
    mkdirSync(join(dir, 'pkg', 'dev'), { recursive: true });
    // Project winner is mobile-only; package duplicate claims extension.
    writeFileSync(
      join(dir, 'proj', 'worker', 'dev.md'),
      '---\nplatforms: [mobile]\n---\n\n# P\n\n- [ ] step\n',
    );
    writeFileSync(
      join(dir, 'pkg', 'dev', 'default.md'),
      '---\nplatforms: [extension]\n---\n\n# S\n\n- [ ] step\n',
    );
    const entries = listExecutionTemplates({
      sources: [
        projectWorkerTemplateSource('p', join(dir, 'proj')),
        packageFlowTreeTemplateSource('s', join(dir, 'pkg')),
      ],
      platform: 'extension',
    });
    // The package copy is shadowed by the (filtered-out) project winner — the
    // filter must not resurrect it as effective.
    const effective = entries.filter((e) => !e.shadowedBy);
    assert.equal(effective.length, 0);
    const shadowedEntry = entries.find((e) => e.shadowedBy);
    assert.equal(shadowedEntry?.sourceKind, 'package');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same-kind precedence follows caller order, not source-id alphabet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'et-order-'));
  try {
    mkdirSync(join(dir, 'zeta', 'dev'), { recursive: true });
    mkdirSync(join(dir, 'alpha', 'dev'), { recursive: true });
    writeFileSync(join(dir, 'zeta', 'dev', 'default.md'), '# Z\n\n- [ ] step\n');
    writeFileSync(join(dir, 'alpha', 'dev', 'default.md'), '# A\n\n- [ ] step\n');
    const entries = listExecutionTemplates({
      sources: [
        customTemplateSource('zeta', join(dir, 'zeta')),
        customTemplateSource('alpha', join(dir, 'alpha')),
      ],
    });
    const winner = entries.find((e) => e.id === 'dev/default' && !e.shadowedBy);
    assert.equal(winner?.sourceId, 'custom:zeta');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create validates before writing: failure leaves no file and force never destroys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'et-create-'));
  try {
    // Un-prefixed filename with explicit flow: rejected BEFORE write.
    assert.throws(
      () => createExecutionTemplate({ path: join(dir, 'evil.md'), flow: 'dev' }),
      /path must encode the flow/,
    );
    assert.equal(existsSync(join(dir, 'evil.md')), false);

    // Contradicting --flow: rejected before write.
    assert.throws(
      () => createExecutionTemplate({ path: join(dir, 'dev.md'), flow: 'review-pr' }),
      /contradicts the path's flow/,
    );
    assert.equal(existsSync(join(dir, 'dev.md')), false);

    // force on an invalid request must not destroy the existing file.
    const keep = join(dir, 'fix-bug.md');
    writeFileSync(keep, '# keep\n\n- [ ] precious\n');
    assert.throws(
      () => createExecutionTemplate({ path: keep, flow: 'dev', force: true }),
      /contradicts the path's flow/,
    );
    assert.match(readFileSync(keep, 'utf8'), /precious/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint rejects traversal-like frontmatter ids and flow/filename contradictions', () => {
  const bad = lintExecutionTemplateText(
    '/virtual/dev.md',
    '---\nid: ../../escape\nflow: review-pr\n---\n\n# T\n\n- [ ] step\n',
  );
  assert.ok(bad.some((i) => /safe catalog id/.test(i.message)));
  assert.ok(bad.some((i) => /contradicts the path's flow/.test(i.message)));
});

test('lint exempts interactive templates from the checkbox requirement', () => {
  const interactive = lintExecutionTemplateText(
    '/virtual/dev-interactive.md',
    '# Conversational template\n\nNo checklist by design.\n',
  );
  assert.equal(interactive.filter((i) => i.severity === 'error').length, 0);
  const autonomous = lintExecutionTemplateText(
    '/virtual/dev.md',
    '# Missing checklist\n\nprose only\n',
  );
  assert.ok(autonomous.some((i) => /no parseable checkbox/.test(i.message)));
});

test('lint flags unterminated frontmatter instead of silently treating it as body', () => {
  const issues = lintExecutionTemplateText(
    '/virtual/dev.md',
    '---\nrunMode: autonomous\n\n# Heading\n\n- [ ] step\n',
  );
  assert.ok(issues.some((i) => /unterminated frontmatter/.test(i.message)));
});

test('create with no metadata renders without a frontmatter block and round-trips through list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'et-roundtrip-'));
  try {
    mkdirSync(join(dir, 'worker'), { recursive: true });
    // Bare title: no runMode token in the filename, default platforms — the
    // generated file must still lint clean and be discoverable.
    createExecutionTemplate({ path: join(dir, 'worker', 'fix-bug.core.md'), title: 'Round trip' });
    const text = readFileSync(join(dir, 'worker', 'fix-bug.core.md'), 'utf8');
    assert.ok(!text.startsWith('---'), 'no empty frontmatter fence pair');
    const entries = listExecutionTemplates({
      sources: [projectWorkerTemplateSource('p', dir)],
    });
    const entry = entries.find((e) => e.id === 'fix-bug/core');
    assert.equal(entry?.title, 'Round trip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parser closes an empty frontmatter block', () => {
  const parsed = parseMarkdownDocument('---\n---\n\n# T\n\n- [ ] step\n');
  assert.notEqual(parsed.frontmatter, null);
  assert.equal(parsed.heading, 'T');
});

test('flow-tree paths create and lint via the parent flow directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'et-flowtree-'));
  try {
    mkdirSync(join(dir, 'fix-bug'), { recursive: true });
    // Basename has no flow prefix — the fix-bug/ directory carries it.
    createExecutionTemplate({ path: join(dir, 'fix-bug', 'core.md'), title: 'Tree base' });
    const issues = lintExecutionTemplates(join(dir, 'fix-bug', 'core.md'));
    assert.equal(issues.ok, true);
    const entries = listExecutionTemplates({
      sources: [packageFlowTreeTemplateSource('s', dir)],
    });
    assert.equal(entries.find((e) => e.id === 'fix-bug/core')?.title, 'Tree base');
    // A contradicting --flow still fails against the directory flow.
    assert.throws(
      () => createExecutionTemplate({ path: join(dir, 'fix-bug', 'other.md'), flow: 'dev' }),
      /contradicts the path's flow/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parent flow directory wins over a contradicting basename, and lint flags it', () => {
  // fix-bug/dev.md must resolve as fix-bug everywhere (catalog parity)…
  assert.equal(catalogRelativeId('fix-bug/dev.md', 'flow-tree'), 'fix-bug/dev');
  const issues = lintExecutionTemplateText('/tmp/fix-bug/dev.md', '# T\n\n- [ ] step\n');
  // …and the misleading name is an authoring error.
  assert.ok(issues.some((i) => /contradicts the flow directory/.test(i.message)));
});

test('mode tokens are exact, not substrings', () => {
  assert.equal(inferRunModeFromBasename('dev-interactively.md'), null);
  assert.equal(inferRunModeFromBasename('dev-autonomousness.md'), null);
});

test('a line merely starting with --- is not a closing fence', () => {
  const parsed = parseMarkdownDocument('---\nrunMode: autonomous\n---not-a-fence\n\n# T\n');
  assert.equal(parsed.frontmatter, null);
  const issues = lintExecutionTemplateText(
    '/virtual/dev.md',
    '---\nrunMode: autonomous\n---not-a-fence\n\n# T\n\n- [ ] step\n',
  );
  assert.ok(issues.some((i) => /unterminated frontmatter/.test(i.message)));
});

test('directory lint flags files that canonicalize to the same catalog id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'et-dup-'));
  try {
    writeFileSync(join(dir, 'dev-interactive.md'), '# A\n');
    writeFileSync(join(dir, 'dev.interactive.md'), '# B\n');
    const result = lintExecutionTemplates(dir);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => /duplicate catalog id 'dev\/interactive'/.test(i.message)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate detection follows explicit frontmatter ids like the resolver', () => {
  const dir = mkdtempSync(join(tmpdir(), 'et-dup2-'));
  try {
    // Same explicit id in differently-named files: a real collision.
    writeFileSync(join(dir, 'dev.md'), '---\nid: shared\n---\n\n# A\n\n- [ ] s\n');
    writeFileSync(join(dir, 'fix-bug.md'), '---\nid: shared\n---\n\n# B\n\n- [ ] s\n');
    const collision = lintExecutionTemplates(dir);
    assert.ok(collision.issues.some((i) => /duplicate catalog id 'shared'/.test(i.message)));
    rmSync(join(dir, 'dev.md'));
    rmSync(join(dir, 'fix-bug.md'));
    // Path-colliding names with DIFFERENT explicit ids: not a collision.
    writeFileSync(join(dir, 'dev-interactive.md'), '---\nid: one\n---\n\n# A\n');
    writeFileSync(join(dir, 'dev.interactive.md'), '---\nid: two\n---\n\n# B\n');
    const distinct = lintExecutionTemplates(dir);
    assert.ok(!distinct.issues.some((i) => /duplicate catalog id/.test(i.message)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bare CR does not terminate a frontmatter fence', () => {
  const parsed = parseMarkdownDocument('---\nrunMode: autonomous\n---\rnot-a-fence\n\n# T\n');
  assert.equal(parsed.frontmatter, null);
});
