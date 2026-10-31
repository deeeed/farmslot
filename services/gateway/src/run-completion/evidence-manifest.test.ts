import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCaptionConfidence,
  buildEvidenceSection,
  captionConfidenceFor,
  collectLowCaptions,
  EvidenceCaptionError,
} from './evidence-manifest.js';

test('buildEvidenceSection matches artifact-prefixed manifest paths to uploaded URLs', () => {
  const section = buildEvidenceSection(
    {
      preferred_mode: 'screenshots',
      before_after_pairs: [
        {
          label: 'AC1',
          before: 'artifacts/before-ac1.png',
          after: 'artifacts/after-ac1.png',
        },
      ],
      videos: {
        after: 'artifacts/after.mp4',
      },
    },
    new Map([
      ['before-ac1.png', 'https://cdn/before-ac1.png'],
      ['after-ac1.png', 'https://cdn/after-ac1.png'],
      ['after.mp4', 'https://cdn/after.mp4'],
    ]),
  );

  assert(section);
  assert.match(section, /https:\/\/cdn\/before-ac1\.png/);
  assert.match(section, /https:\/\/cdn\/after-ac1\.png/);
  assert.match(section, /https:\/\/cdn\/after\.mp4/);
});

test('buildEvidenceSection labels an operator-attested before side as one inert line', () => {
  const section = buildEvidenceSection(
    {
      before_after_pairs: [
        {
          label: 'AC-1',
          before: 'recipe-runs/attested/ac1-before.png',
          after: 'recipe-runs/head/ac1-after.png',
        },
        { label: 'AC-2', before: 'artifacts/recipe-runs/clean/ac2-before.png' },
        { label: 'AC-3', before: 'recipe-runs/attested/ac3-before.png' },
      ],
      videos: { before: 'recipe-runs/attested/before.mp4' },
    },
    new Map([
      ['ac1-before.png', 'https://cdn/ac1-before.png'],
      ['ac1-after.png', 'https://cdn/ac1-after.png'],
      ['ac2-before.png', 'https://cdn/ac2-before.png'],
      ['ac3-before.png', 'https://cdn/ac3-before.png'],
      ['before.mp4', 'https://cdn/before.mp4'],
    ]),
    [
      {
        id: 'attestation',
        runId: 'run',
        decisionId: 'gate',
        attemptRoot: 'recipe-runs/attested',
        manifestSha256: 'f'.repeat(64),
        approver: { principalId: 'person', displayName: 'Reviewer', credentialId: 'credential' },
        reason:
          'The recipe needs <Bridge> files this change adds.\n```\ndiagnostic [x](https://evil) ![](https://img)\n```',
        attestedAt: '2026-10-31T05:00:00.000Z',
      },
    ],
  );

  assert(section);
  // A multi-line fenced reason cannot end the HTML cell, open a fence or render a link.
  const disclosure = String.raw`The recipe needs &lt;Bridge&gt; files this change adds. \`\`\` diagnostic \[x\](https://evil) !\[\](https://img) \`\`\` (Reviewer, 2026-10-31T05:00:00.000Z)`;
  const label = `<em>Before: operator-attested</em><br/><sub>${disclosure}</sub>`;
  assert.equal(section.split(label).length - 1, 2);
  assert.match(section, /<em>Before<\/em><br\/><img src="https:\/\/cdn\/ac2-before\.png"/);
  assert.ok(
    section.includes(
      `- Before (operator-attested: ${disclosure}): [recipe-runs/attested/before.mp4](https://cdn/before.mp4)`,
    ),
  );
});

test('buildEvidenceSection keeps headless summary but never renders proof documents as images', () => {
  const section = buildEvidenceSection(
    {
      summary: 'No visual evidence applies — this is a headless library.',
      standalone: [
        { label: 'Recipe verdict', file: 'recipe-run/summary.json' },
        { label: 'Run report', file: 'recipe-run/report.md' },
        { label: 'Assertion helper', file: 'recipe-support/assert-required-tests.cjs' },
      ],
    },
    new Map([
      ['recipe-run/summary.json', 'artifacts/recipe-run/summary.json'],
      ['recipe-run/report.md', 'artifacts/recipe-run/report.md'],
      [
        'recipe-support/assert-required-tests.cjs',
        'artifacts/recipe-support/assert-required-tests.cjs',
      ],
    ]),
  );

  assert.equal(section, 'No visual evidence applies — this is a headless library.');
  assert.doesNotMatch(section, /<img|<table>/);
});

test('buildEvidenceSection renders media and ignores adjacent non-media entries', () => {
  const section = buildEvidenceSection(
    {
      standalone: [
        { label: 'Visual state', file: 'after-loaded.png' },
        { label: 'Raw report', file: 'report.json' },
      ],
    },
    new Map([
      ['after-loaded.png', 'https://cdn/after-loaded.png'],
      ['report.json', 'https://cdn/report.json'],
    ]),
  );

  assert(section);
  assert.match(section, /https:\/\/cdn\/after-loaded\.png/);
  assert.doesNotMatch(section, /report\.json/);
});

test('buildEvidenceSection renders WebP stills as images, like retained PNG stills', () => {
  const section = buildEvidenceSection(
    {
      before_after_pairs: [{ label: 'AC1', before: 'stills/old.png', after: 'stills/new.webp' }],
      standalone: [{ label: 'Recorded still', file: 'stills/recorded-3.webp' }],
    },
    new Map([
      ['stills/old.png', 'https://cdn/old.png'],
      ['stills/new.webp', 'https://cdn/new.webp'],
      ['stills/recorded-3.webp', 'https://cdn/recorded-3.webp'],
    ]),
  );

  assert(section);
  assert.match(section, /<img[^>]*https:\/\/cdn\/new\.webp/);
  assert.match(section, /<img[^>]*https:\/\/cdn\/old\.png/);
  assert.match(section, /<img[^>]*https:\/\/cdn\/recorded-3\.webp/);
});

test('buildEvidenceSection renders standalone screenshots as a compact two-column grid', () => {
  const section = buildEvidenceSection(
    {
      standalone: [
        { label: 'Collapsed', file: 'collapsed.png', note: 'compact state' },
        { label: 'Expanded', file: 'expanded.png', note: 'chart restored' },
        { label: 'Restarted', file: 'restarted.png', note: 'preference persisted' },
      ],
    },
    new Map([
      ['collapsed.png', 'https://cdn/collapsed.png'],
      ['expanded.png', 'https://cdn/expanded.png'],
      ['restarted.png', 'https://cdn/restarted.png'],
    ]),
  );

  assert(section);
  assert.equal((section.match(/<tr>/g) ?? []).length, 2);
  assert.equal((section.match(/valign="top"/g) ?? []).length, 3);
  assert.equal((section.match(/width="320"/g) ?? []).length, 3);
  assert.match(section, /<sub>preference persisted<\/sub>/);
});

test('captionConfidenceFor: note present -> HIGH', () => {
  const res = captionConfidenceFor(
    { file: 'screenshot.png', note: 'shows populated account list after AC1' },
    new Map([['screenshot.png', 1]]),
  );
  assert.equal(res.level, 'HIGH');
});

test('captionConfidenceFor: whitespace-only note does not qualify as HIGH', () => {
  const res = captionConfidenceFor(
    { file: 'screenshot.png', note: '   ' },
    new Map([['screenshot.png', 1]]),
  );
  assert.notEqual(res.level, 'HIGH');
});

test('captionConfidenceFor: state suffix ac1 -> MEDIUM', () => {
  const res = captionConfidenceFor(
    { file: 'artifacts/ac1-populated.png' },
    new Map([['artifacts/ac1-populated.png', 1]]),
  );
  assert.equal(res.level, 'MEDIUM');
});

test('captionConfidenceFor: state suffix populated -> MEDIUM', () => {
  const res = captionConfidenceFor({ file: 'populated.png' }, new Map([['populated.png', 1]]));
  assert.equal(res.level, 'MEDIUM');
});

test('captionConfidenceFor: state suffix empty-state -> MEDIUM', () => {
  const res = captionConfidenceFor(
    { file: 'view-empty-state.png' },
    new Map([['view-empty-state.png', 1]]),
  );
  assert.equal(res.level, 'MEDIUM');
});

test('captionConfidenceFor: state suffix skeleton -> MEDIUM', () => {
  const res = captionConfidenceFor(
    { before: 'before_skeleton.png', after: 'after_loaded.png' },
    new Map([
      ['before_skeleton.png', 1],
      ['after_loaded.png', 1],
    ]),
  );
  assert.equal(res.level, 'MEDIUM');
});

test('captionConfidenceFor: state suffix baseline + final -> MEDIUM', () => {
  const res = captionConfidenceFor(
    { before: 'baseline.png', after: 'final.png' },
    new Map([
      ['baseline.png', 1],
      ['final.png', 1],
    ]),
  );
  assert.equal(res.level, 'MEDIUM');
});

test('captionConfidenceFor: generic filename screenshot-1.png -> LOW', () => {
  const res = captionConfidenceFor(
    { file: 'screenshot-1.png' },
    new Map([['screenshot-1.png', 1]]),
  );
  assert.equal(res.level, 'LOW');
  assert.match(res.reason ?? '', /generic filename/);
});

test('captionConfidenceFor: generic filename capture.png -> LOW', () => {
  const res = captionConfidenceFor({ file: 'capture.png' }, new Map([['capture.png', 1]]));
  assert.equal(res.level, 'LOW');
});

test('captionConfidenceFor: no file, no note -> LOW no file', () => {
  const res = captionConfidenceFor({}, new Map());
  assert.equal(res.level, 'LOW');
  assert.equal(res.reason, 'no file');
});

test('captionConfidenceFor: duplicate file across entries -> LOW', () => {
  const fileUsage = new Map([['ac1-populated.png', 2]]);
  const res = captionConfidenceFor({ file: 'ac1-populated.png' }, fileUsage);
  assert.equal(res.level, 'LOW');
  assert.match(res.reason ?? '', /multiple entries/);
});

test('captionConfidenceFor: note overrides duplicate-file LOW -> HIGH', () => {
  const fileUsage = new Map([['shared.png', 2]]);
  const res = captionConfidenceFor(
    { file: 'shared.png', note: 'intentionally the same frame — AC2 verifies no change' },
    fileUsage,
  );
  assert.equal(res.level, 'HIGH');
});

test('captionConfidenceFor: subdirectory preserves filename-only matching', () => {
  const res = captionConfidenceFor(
    { file: 'artifacts/nested/before.png' },
    new Map([['artifacts/nested/before.png', 1]]),
  );
  assert.equal(res.level, 'MEDIUM');
});

test('collectLowCaptions: flags generic standalone filenames', () => {
  const lows = collectLowCaptions({
    standalone: [
      { label: 'AC1', file: 'screenshot-1.png' },
      { label: 'AC2', file: 'ac2-populated.png' },
    ],
  });
  assert.equal(lows.length, 1);
  assert.equal(lows[0].label, 'AC1');
  assert.match(lows[0].reason, /generic filename/);
});

test('collectLowCaptions ignores headless proof documents', () => {
  assert.deepEqual(
    collectLowCaptions({
      standalone: [
        { label: 'Recipe result', file: 'summary.json' },
        { label: 'Run report', file: 'report.md' },
      ],
    }),
    [],
  );
});

test('collectLowCaptions: flags pairs sharing the same file', () => {
  const lows = collectLowCaptions({
    before_after_pairs: [{ label: 'AC1 flow', before: 'shared.png', after: 'shared.png' }],
  });
  assert.equal(lows.length, 1);
  assert.match(lows[0].reason, /multiple entries/);
});

test('collectLowCaptions: returns empty when every caption is HIGH or MEDIUM', () => {
  const lows = collectLowCaptions({
    standalone: [
      { label: 'AC1', file: 'ac1-populated.png' }, // MEDIUM
      { label: 'AC2', file: 'capture.png', note: 'populated trades visible in Recent Activity' }, // HIGH
    ],
  });
  assert.equal(lows.length, 0);
});

test('assertCaptionConfidence: throws EvidenceCaptionError on LOW', () => {
  assert.throws(
    () =>
      assertCaptionConfidence({
        standalone: [{ label: 'generic', file: 'capture.png' }],
      }),
    (err: Error) => {
      assert.ok(err instanceof EvidenceCaptionError);
      assert.equal((err as EvidenceCaptionError).lowCaptions.length, 1);
      return true;
    },
  );
});

test('assertCaptionConfidence: passes when all captions qualify', () => {
  assert.doesNotThrow(() =>
    assertCaptionConfidence({
      standalone: [
        { label: 'AC1', file: 'ac1-skeleton.png' },
        { label: 'AC2', file: 'generic.png', note: 'explicit state description' },
      ],
    }),
  );
});
