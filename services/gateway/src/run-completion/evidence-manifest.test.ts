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
