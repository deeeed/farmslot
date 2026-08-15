import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RawProjectJson } from '../core/config.js';

import { buildDraftPrBody } from './draft-pr.js';
import { buildEvidenceSection } from './evidence-manifest.js';
import {
  assertReadyGatePackageInputsCurrent,
  assertSelectedEvidencePublished,
  defaultReviewDepthPolicy,
  defaultSelectedEvidenceKeysForPublication,
  effectiveRequiredReviewCount,
  expandEvidenceSelectionForManifest,
  filterArtifactUrlsByEvidenceSelection,
  filterEvidenceManifestBySelection,
  independentReviewPolicySatisfied,
  inferRetrospectiveOutcome,
  isArtifactOnlyRun,
  isPublishedStatus,
  localPrBodyPathResidues,
  publicationReviewPolicyForRun,
  publicationStatusForRun,
  readCommentsTriageSummary,
  readEvidenceManifest,
  sanitizePRBody,
  selectedEvidenceKeysForPublication,
} from './orchestrator.js';
import { makeRun } from './test-fixtures.js';

test('assertSelectedEvidencePublished fails closed for non-empty approved evidence selection', () => {
  assert.doesNotThrow(() => assertSelectedEvidencePublished([], new Map()));
  assert.doesNotThrow(() =>
    assertSelectedEvidencePublished(['artifacts/after.png'], new Map([['after.png', 'url']])),
  );
  assert.doesNotThrow(() =>
    assertSelectedEvidencePublished(
      ['artifacts/screenshots/after.png'],
      new Map([['screenshots/after.png', 'url']]),
    ),
  );
  assert.doesNotThrow(() =>
    assertSelectedEvidencePublished(['./after.png'], new Map([['nested/after.png', 'url']])),
  );
  assert.doesNotThrow(() =>
    assertSelectedEvidencePublished(
      [
        'artifacts/after.png',
        'artifacts/after-capture-helper.log',
        'artifacts/recipe-capture-helper.json',
      ],
      new Map([['after.png', 'url']]),
    ),
  );
  assert.doesNotThrow(() =>
    assertSelectedEvidencePublished(
      ['artifacts/after-capture-helper.log', 'artifacts/recipe-capture-helper.json'],
      new Map(),
    ),
  );
  assert.throws(
    () => assertSelectedEvidencePublished(['artifacts/after.png'], new Map()),
    /Selected evidence was not published/,
  );
  assert.throws(
    () =>
      assertSelectedEvidencePublished(
        ['artifacts/before.png', 'artifacts/after.png'],
        new Map([['after.png', 'url']]),
      ),
    /before\.png/,
  );
});

test('selectedEvidenceKeysForPublication drops non-publishable sidecar artifacts', () => {
  assert.deepEqual(
    selectedEvidenceKeysForPublication({
      selectedEvidenceKeys: [
        'artifacts/after-capture-helper-ac1-orders-spacing.png',
        'artifacts/after-capture-helper.log',
        'artifacts/recipe-capture-helper.json',
        'artifacts/screenshots/manifest-proof.png',
      ],
      evidenceManifest: [
        {
          path: 'artifacts/after-capture-helper-ac1-orders-spacing.png',
          purpose: 'screenshot',
        },
        { path: 'artifacts/after-capture-helper.log', purpose: 'log' },
        { path: 'artifacts/recipe-capture-helper.json', purpose: 'json' },
        {
          path: 'artifacts/screenshots/manifest-proof.png',
          purpose: 'screenshot',
        },
      ],
      trustedEvidenceManifest: {
        preferred_mode: 'screenshots',
        standalone: [{ label: 'Manifest proof', file: 'screenshots/manifest-proof.png' }],
      },
    }),
    [
      'artifacts/after-capture-helper-ac1-orders-spacing.png',
      'artifacts/screenshots/manifest-proof.png',
    ],
  );
});

test('defaultSelectedEvidenceKeysForPublication keeps local proof videos out of PR body selection', () => {
  const evidenceManifest = [
    { path: 'artifacts/after.png', purpose: 'screenshot' },
    { path: 'artifacts/after.mp4', purpose: 'video-after' },
  ];
  const trustedEvidenceManifest = {
    preferred_mode: 'screenshots' as const,
    standalone: [{ label: 'After', file: 'after.png' }],
    videos: { after: 'after.mp4' },
  };

  assert.deepEqual(
    defaultSelectedEvidenceKeysForPublication({
      evidenceManifest,
      trustedEvidenceManifest,
    }),
    ['artifacts/after.png'],
  );
  assert.deepEqual(
    selectedEvidenceKeysForPublication({
      selectedEvidenceKeys: ['artifacts/after.mp4'],
      evidenceManifest,
      trustedEvidenceManifest,
    }),
    ['artifacts/after.mp4'],
  );
});

test('localPrBodyPathResidues flags local media paths before approved publication', () => {
  assert.deepEqual(localPrBodyPathResidues('remote https://example.com/tmp/after.png is fine'), []);
  assert.deepEqual(
    localPrBodyPathResidues(
      'remote https://raw.githubusercontent.com/owner/repo/main/reviews/1/artifacts/after.png is fine',
    ),
    [],
  );
  assert.deepEqual(localPrBodyPathResidues('remote https://cdn.example/screenshots/after.png'), []);
  assert.deepEqual(localPrBodyPathResidues('remote https://cdn.example/videos/after.webm'), []);
  assert.deepEqual(
    localPrBodyPathResidues(
      '<a href="https://raw.githubusercontent.com/owner/repo/main/fixes/1/recipe-runs/inherited-run/before.mp4?sha=abc">recipe-runs/inherited-run/before.mp4</a>',
    ),
    [],
    'a local-looking label backed by a hosted evidence URL is already published',
  );
  assert.deepEqual(
    localPrBodyPathResidues(
      '[recipe-runs/inherited-run/before.mp4](https://cdn.example/fixes/1/before.mp4)',
    ),
    [],
    'markdown links to hosted evidence are already published',
  );
  assert.deepEqual(localPrBodyPathResidues('see /Users/me/task/artifacts/after.png'), [
    '/Users/me/task/artifacts/after.png',
  ]);
  assert.deepEqual(localPrBodyPathResidues('<img src="artifacts/before.png" />'), [
    'artifacts/before.png',
  ]);
  assert.deepEqual(localPrBodyPathResidues('See artifacts/report.md'), ['artifacts/report.md']);
  // Inline code is provenance narration for non-media paths: worker reports cite
  // `artifacts/recipe-run/` and quote upstream breakage like `require("file:///…")`,
  // and both killed FINALIZE on real runs (fcf4f0f7, 4f488307). Media stays
  // flagged even in backticks — quoting a screenshot does not make it visible.
  assert.deepEqual(localPrBodyPathResidues('See `artifacts/recipe.json`.'), []);
  assert.deepEqual(localPrBodyPathResidues('Re-run at tip: `artifacts/recipe-run/` results.'), []);
  assert.deepEqual(
    localPrBodyPathResidues('ts-bridge emits `require("file:///home/runner/work/hl/mod.ts")`.'),
    [],
  );
  assert.deepEqual(localPrBodyPathResidues('See `artifacts/after.png`.'), ['artifacts/after.png']);
  assert.deepEqual(localPrBodyPathResidues('See `/Users/me/task/artifacts/after.png`.'), [
    '/Users/me/task/artifacts/after.png',
  ]);
  assert.deepEqual(localPrBodyPathResidues('See .task/run/artifacts/summary.json'), [
    '.task/run/artifacts/summary.json',
  ]);
  assert.deepEqual(localPrBodyPathResidues('See temp/recipe/summary.json'), [
    'temp/recipe/summary.json',
  ]);
  assert.deepEqual(localPrBodyPathResidues('See recipe-runs/live/after.png'), [
    'recipe-runs/live/after.png',
  ]);
  assert.deepEqual(localPrBodyPathResidues('[before](before.mp4)'), ['before.mp4']);
  assert.deepEqual(localPrBodyPathResidues('remote https://cdn.example/evidence-1.png'), []);
  assert.deepEqual(localPrBodyPathResidues('[proof](file:///tmp/proof.mp4)'), [
    'file:///tmp/proof.mp4',
  ]);
  assert.deepEqual(
    localPrBodyPathResidues(
      'recipe doc:\n\n```json\n{ "filename": "evidence-ac1.png", "next": "evidence-ac3.png" }\n```\n',
    ),
    [],
    'fenced code blocks (recipe JSON) must not trip residue check',
  );
  assert.deepEqual(
    localPrBodyPathResidues('inline `evidence-ac1.png` reference'),
    [],
    'inline code spans must not trip residue check',
  );
  assert.deepEqual(
    localPrBodyPathResidues(
      'recipe:\n```\nevidence-ac1.png\n```\nalso loose <img src="artifacts/before.png" />',
    ),
    ['artifacts/before.png'],
    'residues outside code blocks still get flagged',
  );
});

test('sanitizePRBody preserves uploaded evidence links with local-looking labels', () => {
  const hostedAnchor =
    '<a href="https://cdn.example/reviews/1/before.mp4">recipe-runs/inherited/before.mp4</a>';
  const hostedMarkdown =
    '[artifacts/screenshots/after.png](https://cdn.example/reviews/1/after.png)';

  assert.equal(
    sanitizePRBody(`${hostedAnchor}\n${hostedMarkdown}`),
    `${hostedAnchor}\n${hostedMarkdown}`,
  );
  assert.equal(
    sanitizePRBody('See artifacts/screenshots/after.png\nKeep this.').trim(),
    'Keep this.',
  );
  const hostedImage = '<img src="https://cdn.example/reviews/1/after.png" />';
  assert.equal(
    sanitizePRBody(`| ${hostedImage} | artifacts/screenshots/after.png |`).trim(),
    `| ${hostedImage} |  |`,
  );
  assert.equal(
    sanitizePRBody(
      '<img src="https://cdn.example/reviews/1/after.png" alt="artifacts/screenshots/after-state.png" />',
    ),
    '<img src="https://cdn.example/reviews/1/after.png" alt="After State" />',
  );
  assert.equal(
    sanitizePRBody('| a | b |\n| --- | --- |\n| x | artifacts/y/z.png |\n| q | r |'),
    '| a | b |\n| --- | --- |\n| q | r |',
  );
  assert.equal(sanitizePRBody('- one\n- see artifacts/y/z.png\n- three'), '- one\n- three');
  assert.equal(
    sanitizePRBody(`${hostedMarkdown} (from artifacts/screenshots/after.png)`).trim(),
    hostedMarkdown,
  );
  assert.equal(
    sanitizePRBody(`${hostedMarkdown} (source: artifacts/screenshots/after.png)`).trim(),
    hostedMarkdown,
  );
  assert.equal(
    sanitizePRBody(
      `<tr><td colspan="2"><strong>Companion before/after — recipe-runs/fs-4/before.mp4</strong></td></tr>`,
    ).trim(),
    `<tr><td colspan="2"><strong>Companion before/after — Before</strong></td></tr>`,
  );
  assert.equal(
    sanitizePRBody(
      `<tr><td>${hostedImage}</td><td><strong>Companion before/after — recipe-runs/fs-4/before.mp4</strong></td></tr>`,
    ).trim(),
    `<tr><td>${hostedImage}</td><td><strong>Companion before/after — Before</strong></td></tr>`,
  );
  assert.equal(
    sanitizePRBody(`${hostedMarkdown} (captured at artifacts/screenshots/after.png)`).trim(),
    hostedMarkdown,
  );
  assert.equal(
    sanitizePRBody(`- **Source**: artifacts/screenshots/after.png → ${hostedMarkdown}`).trim(),
    `- **Source**: ${hostedMarkdown}`,
  );
  assert.equal(
    sanitizePRBody(`| proof | ${hostedMarkdown} | \`artifacts/screenshots/after.png\` |`).trim(),
    `| proof | ${hostedMarkdown} |  |`,
  );

  const generatedSection = buildEvidenceSection(
    {
      preferred_mode: 'screenshots',
      before_after_pairs: [
        {
          label: 'recipe-runs/fs-4/before.mp4 vs after',
          before: 'recipe-runs/fs-4/before-state.png',
          after: 'recipe-runs/fs-4/after-state.png',
        },
      ],
    },
    new Map([
      ['recipe-runs/fs-4/before-state.png', 'https://cdn.example/reviews/1/before.png'],
      ['recipe-runs/fs-4/after-state.png', 'https://cdn.example/reviews/1/after.png'],
    ]),
  );
  assert.ok(generatedSection);
  const sanitizedSection = sanitizePRBody(generatedSection);
  assert.match(sanitizedSection, /<strong>Before vs after<\/strong>/);
  assert.match(sanitizedSection, /src="https:\/\/cdn\.example\/reviews\/1\/before\.png"/);
  assert.match(sanitizedSection, /src="https:\/\/cdn\.example\/reviews\/1\/after\.png"/);
  assert.deepEqual(localPrBodyPathResidues(sanitizedSection), []);
  assert.equal(
    sanitizePRBody('__FARMSLOT_REMOTE_LINK_0__\n' + hostedMarkdown),
    '__FARMSLOT_REMOTE_LINK_0__\n' + hostedMarkdown,
  );
});

test('isArtifactOnlyRun only matches the artifact-only completion policy', () => {
  assert.equal(isArtifactOnlyRun(makeRun({ completionPolicy: 'artifact-only' })), true);
  assert.equal(isArtifactOnlyRun(makeRun({ completionPolicy: 'default' })), false);
  assert.equal(isArtifactOnlyRun(makeRun({ completionPolicy: undefined })), false);
});

test('readCommentsTriageSummary counts normalized bot and human review-source signals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-comments-triage-'));
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await writeFile(
    path.join(root, 'artifacts', 'comments-triage.json'),
    JSON.stringify([
      {
        triage: 'REAL',
        fixed_in_commit: 'abc123',
        path: 'src/a.ts',
        source_kind: 'bugbot',
        author_login: 'cursor[bot]',
        author_type: 'Bot',
        comment_id: 1,
      },
      {
        triage: 'REAL',
        fixed_in_commit: 'def456',
        path: 'src/b.ts',
        source_kind: 'human',
        author_login: 'alice',
        author_type: 'User',
        reviewer_login: 'alice',
        review_state: 'CHANGES_REQUESTED',
        comment_id: 2,
        review_id: 20,
      },
      {
        triage: 'REAL',
        fixed_in_commit: null,
        path: 'src/c.ts',
        source_kind: 'human',
        author_login: 'alice',
        author_type: 'User',
        reviewer_login: 'alice',
        review_state: 'CHANGES_REQUESTED',
        comment_id: 3,
        review_id: 20,
      },
      { triage: 'FALSE_POSITIVE', fixed_in_commit: null, path: 'src/d.ts', comment_id: 4 },
    ]),
  );

  const summary = await readCommentsTriageSummary(root);

  assert(summary);
  assert.equal(summary.total, 4);
  assert.equal(summary.real, 3);
  assert.equal(summary.fixed, 2);
  assert.equal(summary.botAddressed, 1);
  assert.equal(summary.humanCommentsAddressed, 1);
  assert.equal(summary.humanReviewersRequestingChanges, 1);
  assert.equal(summary.unknownSource, 1);
  assert.deepEqual(summary.actionablePaths, ['src/a.ts', 'src/b.ts']);
});

test('readEvidenceManifest rejects unknown manifest keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-pr-body-invalid-manifest-'));
  try {
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    const taskFile = path.join(root, 'task.md');
    await writeFile(taskFile, '# Task\n');
    await writeFile(
      path.join(root, 'artifacts', 'evidence-manifest.json'),
      JSON.stringify({
        version: 1,
        preferred_mode: 'screenshots',
        summary: 'Legacy visual proof summary.',
        pairs: [
          {
            label: 'Order placeholder',
            before: 'before-ac1-placeholder.png',
            after: 'after-ac1-placeholder.png',
            note: 'Before showed min placeholder; after shows 0.00.',
          },
        ],
      }),
    );

    assert.equal(await readEvidenceManifest(makeRun({ taskFile })), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readEvidenceManifest accepts before-state capture metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-pr-body-before-state-manifest-'));
  try {
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    const taskFile = path.join(root, 'task.md');
    await writeFile(taskFile, '# Task\n');
    await writeFile(
      path.join(root, 'artifacts', 'evidence-manifest.json'),
      JSON.stringify({
        version: 1,
        preferred_mode: 'screenshots',
        before_after_pairs: [
          {
            label: 'AC1',
            before: 'before-ac1.png',
            after: 'after-ac1.png',
          },
        ],
        before_state_capture: {
          method: 'temporary checkout of baseline files',
        },
        omit: [
          'debug-before.png',
          { file: 'debug-after.png', reason: 'debug-only runner screenshot' },
        ],
      }),
    );

    const manifest = await readEvidenceManifest(makeRun({ taskFile }));
    assert.equal(manifest?.before_state_capture?.method, 'temporary checkout of baseline files');
    assert.deepEqual(manifest?.omit, [
      'debug-before.png',
      { file: 'debug-after.png', reason: 'debug-only runner screenshot' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readEvidenceManifest falls back to inherited and promoted recipe manifests', async () => {
  const inheritedRoot = await mkdtemp(path.join(tmpdir(), 'farmslot-inherited-manifest-'));
  try {
    await mkdir(path.join(inheritedRoot, 'inputs', 'inherited'), { recursive: true });
    const inheritedTaskFile = path.join(inheritedRoot, 'task.md');
    await writeFile(inheritedTaskFile, '# Task\n');
    await writeFile(
      path.join(inheritedRoot, 'inputs', 'inherited', 'evidence-manifest.json'),
      JSON.stringify({
        version: 1,
        preferred_mode: 'screenshots',
        summary: 'Inherited curated evidence.',
        standalone: [{ label: 'Result', file: 'evidence-result.png' }],
      }),
    );

    const inheritedManifest = await readEvidenceManifest(makeRun({ taskFile: inheritedTaskFile }));
    assert.equal(inheritedManifest?.summary, 'Inherited curated evidence.');

    const promotedRoot = await mkdtemp(path.join(tmpdir(), 'farmslot-promoted-manifest-'));
    try {
      await mkdir(path.join(promotedRoot, 'artifacts', 'recipe-runs', 'passing-run'), {
        recursive: true,
      });
      const promotedTaskFile = path.join(promotedRoot, 'task.md');
      await writeFile(promotedTaskFile, '# Task\n');
      await writeFile(
        path.join(promotedRoot, 'artifacts', 'latest-valid-recipe-run.json'),
        JSON.stringify({
          version: 1,
          runId: 'passing-run',
          relativeArtifactRoot: 'recipe-runs/passing-run',
        }),
      );
      await writeFile(
        path.join(
          promotedRoot,
          'artifacts',
          'recipe-runs',
          'passing-run',
          'evidence-manifest.json',
        ),
        JSON.stringify({
          version: 1,
          preferred_mode: 'screenshots',
          summary: 'Promoted recipe evidence.',
          standalone: [{ label: 'Promoted', file: 'promoted.png' }],
        }),
      );

      const promotedManifest = await readEvidenceManifest(makeRun({ taskFile: promotedTaskFile }));
      assert.equal(promotedManifest?.summary, 'Promoted recipe evidence.');
      assert.equal(
        promotedManifest?.standalone?.[0]?.file,
        'artifacts/recipe-runs/passing-run/promoted.png',
      );
    } finally {
      await rm(promotedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(inheritedRoot, { recursive: true, force: true });
  }
});

test('assertReadyGatePackageInputsCurrent rejects mutable body and manifest drift', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-package-inputs-current-'));
  try {
    const artifactsDir = path.join(root, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const taskFile = path.join(root, 'task.md');
    const imageBytes = Buffer.from('image-a');
    const debugImageBytes = Buffer.from('debug-image');
    const videoBytes = Buffer.from('video-a');
    const prDescription = [
      '## Summary',
      'First body.',
      '',
      '## **Screenshots/Recordings**',
      '',
    ].join('\n');
    const manifestText = JSON.stringify({
      version: 1,
      preferred_mode: 'screenshots',
      before_after_pairs: [{ label: 'AC1', after: 'after-ac1.png' }],
      videos: { after: 'after.mp4', preferred: false },
    });
    await writeFile(taskFile, '# Task\n');
    await writeFile(path.join(artifactsDir, 'after-ac1.png'), imageBytes);
    await writeFile(path.join(artifactsDir, 'debug-after-long.png'), debugImageBytes);
    await writeFile(path.join(artifactsDir, 'after.mp4'), videoBytes);
    await writeFile(path.join(artifactsDir, 'pr-description.md'), prDescription);
    await writeFile(path.join(artifactsDir, 'evidence-manifest.json'), manifestText);
    const run = makeRun({
      id: 'pkg-input-run',
      flowType: 'dev',
      mode: 'autonomous',
      ticketOrPr: 'PROJ-1',
      taskFile,
    });
    const sha256 = createHash('sha256').update(imageBytes).digest('hex');
    const videoSha256 = createHash('sha256').update(videoBytes).digest('hex');
    const draftBody = await buildDraftPrBody(run, null, [
      { path: 'artifacts/after-ac1.png', purpose: 'screenshot', sizeBytes: imageBytes.length },
      { path: 'artifacts/after.mp4', purpose: 'video', sizeBytes: videoBytes.length },
      {
        path: 'artifacts/evidence-manifest.json',
        purpose: 'evidence-manifest',
        sizeBytes: Buffer.byteLength(manifestText),
      },
      {
        path: 'artifacts/pr-description.md',
        purpose: 'pr-description',
        sizeBytes: Buffer.byteLength(prDescription),
      },
    ]);

    const prPackage = {
      id: 'pkg-inputs',
      packageHash: 'unused',
      artifactPath: 'artifacts/pr-package.json',
      branch: 'feature/pkg-inputs',
      headSha: 'abc123',
      diffStat: { files: 1, additions: 1, deletions: 0 },
      draftTitle: 'feat: implement PROJ-1',
      draftBody,
      evidenceManifest: [
        {
          path: 'artifacts/after-ac1.png',
          purpose: 'screenshot',
          sizeBytes: imageBytes.length,
          sha256,
        },
        {
          path: 'artifacts/after.mp4',
          purpose: 'video-after',
          sizeBytes: videoBytes.length,
          sha256: videoSha256,
        },
      ],
      selectedEvidenceKeys: ['artifacts/after-ac1.png'],
      validationSummaryPath: null,
      validationSummaryHash: null,
      reviewArtifactIds: [],
      dispatchMode: 'autonomous',
      gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'test' },
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      createdAt: '2026-05-18T00:00:00.000Z',
    } satisfies Parameters<typeof assertReadyGatePackageInputsCurrent>[1];

    await assertReadyGatePackageInputsCurrent(run, prPackage);

    await writeFile(path.join(artifactsDir, 'pr-description.md'), '## Summary\nEdited body.\n');
    await assert.rejects(
      assertReadyGatePackageInputsCurrent(run, prPackage),
      /refresh package and re-review.*draft body/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filterEvidenceManifestBySelection prunes deselected videos while preserving selected screenshots', () => {
  const manifest = {
    preferred_mode: 'screenshots' as const,
    before_after_pairs: [
      {
        label: 'Order form',
        before: 'before-order.png',
        after: 'after-order.png',
      },
    ],
    videos: {
      before: 'before-order.mp4',
      after: 'after-order.mp4',
    },
  };
  const filteredManifest = filterEvidenceManifestBySelection(manifest, [
    'artifacts/before-order.png',
    'artifacts/after-order.png',
  ]);
  const filteredUrls = filterArtifactUrlsByEvidenceSelection(
    new Map([
      ['before-order.png', 'https://cdn/before-order.png'],
      ['after-order.png', 'https://cdn/after-order.png'],
      ['before-order.mp4', 'https://cdn/before-order.mp4'],
      ['after-order.mp4', 'https://cdn/after-order.mp4'],
    ]),
    ['artifacts/before-order.png', 'artifacts/after-order.png'],
  );

  const section = buildEvidenceSection(filteredManifest, filteredUrls);

  assert(section);
  assert.match(section, /before-order\.png/);
  assert.match(section, /after-order\.png/);
  assert.doesNotMatch(section, /Video/);
  assert.doesNotMatch(section, /\.mp4/);
});

test('expandEvidenceSelectionForManifest publishes before/after counterparts for selected pairs', () => {
  const manifest = {
    preferred_mode: 'screenshots' as const,
    before_after_pairs: [
      {
        label: 'AC1',
        before: 'before-ac1.png',
        after: 'after-ac1.png',
      },
    ],
    videos: {
      before: 'before.mp4',
      after: 'after.mp4',
    },
  };

  const expanded = expandEvidenceSelectionForManifest(manifest, [
    'artifacts/after-ac1.png',
    'artifacts/after.mp4',
  ]);

  assert.deepEqual(
    new Set(expanded),
    new Set([
      'artifacts/after-ac1.png',
      'artifacts/after.mp4',
      'before-ac1.png',
      'after-ac1.png',
      'before.mp4',
      'after.mp4',
    ]),
  );
});

test('local-first publication statuses only treat draft/ready as published', () => {
  assert.equal(isPublishedStatus('not_published'), false);
  assert.equal(isPublishedStatus('pending_publish'), false);
  assert.equal(isPublishedStatus('publish_failed'), false);
  assert.equal(isPublishedStatus('published_draft'), true);
  assert.equal(isPublishedStatus('published_ready'), true);
  assert.equal(publicationStatusForRun(makeRun()), 'not_published');
  assert.equal(
    publicationStatusForRun(
      makeRun({
        engineState: { publishGate: { publicationStatus: 'published_draft' } },
      }),
    ),
    'published_draft',
  );
});

test('independent review policy requires passing reviews and optional cross-runner depth', () => {
  const base = defaultReviewDepthPolicy();
  assert.deepEqual(base, {
    minimumIndependentReviews: 1,
    requireCrossRunner: false,
    extraLoopsRequested: 0,
    requestedBy: 'dispatch',
  });
  assert.equal(independentReviewPolicySatisfied(base, []), false);
  assert.equal(
    independentReviewPolicySatisfied(base, [
      {
        id: 'review-1',
        crossRunner: false,
        loopNumber: 1,
        verdict: 'issues',
        unresolvedCount: 1,
      },
    ]),
    false,
  );
  assert.equal(
    independentReviewPolicySatisfied(base, [
      {
        id: 'review-1',
        crossRunner: false,
        loopNumber: 1,
        verdict: 'pass',
        unresolvedCount: 0,
        validationDepth: 'static-code',
      },
    ]),
    true,
  );
  assert.equal(
    independentReviewPolicySatisfied(base, [
      {
        id: 'review-1',
        crossRunner: false,
        loopNumber: 1,
        verdict: 'pass',
        unresolvedCount: 0,
        validationDepth: 'full-live',
      },
    ]),
    true,
  );
  assert.equal(
    independentReviewPolicySatisfied(base, [
      {
        id: 'self-review-1',
        source: 'self-review',
        crossRunner: true,
        loopNumber: 1,
        verdict: 'pass',
        unresolvedCount: 0,
        validationDepth: 'full-live',
      },
    ]),
    false,
  );
  assert.equal(
    independentReviewPolicySatisfied(
      {
        ...base,
        requireCrossRunner: true,
        extraLoopsRequested: 1,
        requestedBy: 'human-gate',
      },
      [
        { id: 'review-1', crossRunner: false, loopNumber: 1, verdict: 'pass', unresolvedCount: 0 },
        { id: 'review-2', crossRunner: true, loopNumber: 2, verdict: 'pass', unresolvedCount: 0 },
      ],
    ),
    true,
  );
});

test('publication review policy defaults and config preserve local-first review depth', () => {
  const fixBugPolicy = publicationReviewPolicyForRun(makeRun({ flowType: 'fix-bug' }));
  assert.equal(fixBugPolicy.minimumIndependentReviews, 1);
  assert.equal(effectiveRequiredReviewCount(fixBugPolicy), 1);

  const autonomousDevPolicy = publicationReviewPolicyForRun(
    makeRun({ flowType: 'dev', mode: 'autonomous' }),
  );
  assert.equal(autonomousDevPolicy.minimumIndependentReviews, 0);
  assert.equal(effectiveRequiredReviewCount(autonomousDevPolicy), 0);
  assert.equal(independentReviewPolicySatisfied(autonomousDevPolicy, []), true);

  const reviewedInteractiveDevPolicy = publicationReviewPolicyForRun(
    makeRun({ flowType: 'dev', mode: 'interactive', devInteractiveProfile: 'reviewed' }),
    {
      publication_review: { dev: { minimum_independent_reviews: 1 } },
    } satisfies Partial<RawProjectJson>,
  );
  assert.equal(reviewedInteractiveDevPolicy.minimumIndependentReviews, 1);
  assert.equal(effectiveRequiredReviewCount(reviewedInteractiveDevPolicy), 1);

  const configuredDevPolicy = publicationReviewPolicyForRun(
    makeRun({ flowType: 'dev', mode: 'autonomous' }),
    {
      publication_review: { dev: { minimum_independent_reviews: 1 } },
    } satisfies Partial<RawProjectJson>,
  );
  assert.equal(configuredDevPolicy.minimumIndependentReviews, 1);

  const crossRunnerPolicy = publicationReviewPolicyForRun(
    makeRun({ flowType: 'dev', mode: 'autonomous' }),
    {
      publication_review: { dev: { minimum_independent_reviews: 0, require_cross_runner: true } },
    } satisfies Partial<RawProjectJson>,
  );
  assert.equal(crossRunnerPolicy.minimumIndependentReviews, 1);
  assert.equal(crossRunnerPolicy.requireCrossRunner, true);

  const extraLoopPolicy = publicationReviewPolicyForRun(
    makeRun({ flowType: 'dev', mode: 'autonomous' }),
    undefined,
    { ...autonomousDevPolicy, extraLoopsRequested: 2, requestedBy: 'human-gate' },
  );
  assert.equal(effectiveRequiredReviewCount(extraLoopPolicy), 2);
});

test('inferRetrospectiveOutcome prefers persisted metrics outcome when present', () => {
  assert.equal(
    inferRetrospectiveOutcome(
      makeRun({
        metrics: {
          nudgeCount: 0,
          model: 'opus',
          runner: 'claude',
          runnerSessionId: null,
          runnerSessionPath: null,
          outcome: 'success',
        },
      }),
    ),
    'success',
  );
});

test('inferRetrospectiveOutcome derives success from passed ci-watch before final run outcome is written', () => {
  assert.equal(
    inferRetrospectiveOutcome(
      makeRun({
        status: 'ci-watching',
        steps: [
          { name: 'complete', status: 'done' },
          { name: 'finalize', status: 'done' },
          { name: 'ci-watch', status: 'done', outputs: { result: 'passed' } },
        ],
      }),
    ),
    'success',
  );
});

test('inferRetrospectiveOutcome derives partial from unresolved ci-watch terminal states', () => {
  assert.equal(
    inferRetrospectiveOutcome(
      makeRun({
        status: 'ci-watching',
        steps: [{ name: 'ci-watch', status: 'done', outputs: { result: 'timeout' } }],
      }),
    ),
    'partial',
  );
});
