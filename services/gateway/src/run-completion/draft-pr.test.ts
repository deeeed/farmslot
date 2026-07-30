import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDraftPrBody, buildDraftPrTitle } from './draft-pr.js';
import { makeRun } from './test-fixtures.js';

test('buildDraftPrBody renders local before/after evidence preview from manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-pr-body-evidence-'));
  try {
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    const taskFile = path.join(root, 'task.md');
    await writeFile(taskFile, '# Task\n');
    await writeFile(
      path.join(root, 'artifacts', 'pr-description.md'),
      [
        '## **Description**',
        '',
        'Fix order entry.',
        '',
        '## **Screenshots/Recordings**',
        '',
        '<!-- [screenshots/recordings] -->',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'artifacts', 'evidence-manifest.json'),
      JSON.stringify({
        version: 1,
        preferred_mode: 'screenshots',
        summary: 'Visual proof summary.',
        before_after_pairs: [
          {
            label: 'Order placeholder',
            before: 'before-ac1-placeholder.png',
            after: 'after-ac1-placeholder.png',
            note: 'Before showed min placeholder; after shows 0.00.',
          },
        ],
      }),
    );

    const body = await buildDraftPrBody(makeRun({ taskFile }), null, [
      { path: 'artifacts/before-ac1-placeholder.png', purpose: 'screenshot' },
      { path: 'artifacts/after-ac1-placeholder.png', purpose: 'screenshot' },
    ]);

    assert.match(body, /Visual proof summary/);
    assert.match(body, /<table>/);
    assert.match(body, /img src="artifacts\/before-ac1-placeholder\.png"/);
    assert.match(body, /img src="artifacts\/after-ac1-placeholder\.png"/);
    assert.doesNotMatch(body, /\[screenshots\/recordings\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildDraftPrBody trusts evidence-manifest screenshots even when artifact scan excluded screenshots spool', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-pr-body-manifest-screenshots-'));
  try {
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    const taskFile = path.join(root, 'task.md');
    await writeFile(taskFile, '# Task\n');
    await writeFile(
      path.join(root, 'artifacts', 'pr-description.md'),
      [
        '## **Description**',
        '',
        'Fix order entry.',
        '',
        '## **Screenshots/Recordings**',
        '',
        '<!-- [screenshots/recordings] -->',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'artifacts', 'evidence-manifest.json'),
      JSON.stringify({
        version: 1,
        preferred_mode: 'screenshots',
        summary: 'Manifest screenshots are the source of truth.',
        standalone: [
          {
            label: 'AC1 proof',
            file: 'screenshots/evidence-ac1.png',
          },
        ],
      }),
    );

    const body = await buildDraftPrBody(makeRun({ taskFile }), null, [
      { path: 'artifacts/evidence-manifest.json', purpose: 'evidence-manifest' },
    ]);

    assert.match(body, /Manifest screenshots are the source of truth/);
    assert.match(body, /img src="artifacts\/screenshots\/evidence-ac1\.png"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildDraftPrTitle strips platform prefixes and infers perps conventional scope', () => {
  const run = makeRun({
    flowType: 'dev',
    ticketData: {
      source: 'jira',
      title: '[Extension] Show liquidation distance % on market detail',
      description: 'Display liquidation distance on the Perps positions tab.',
      acceptanceCriteria: [],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });

  assert.equal(buildDraftPrTitle(run), 'feat(perps): show liquidation distance % on market detail');
});

test('buildDraftPrTitle strips the Core platform prefix', () => {
  const run = makeRun({
    flowType: 'fix-bug',
    ticketData: {
      source: 'jira',
      title: '[Core] order 0: insufficient margin to place order',
      description: 'Fix Perps max-size market buys.',
      acceptanceCriteria: [],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });

  assert.equal(buildDraftPrTitle(run), 'fix(perps): order 0: insufficient margin to place order');
});

test('buildDraftPrBody strips execution provenance before the public summary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-pr-body-report-preamble-'));
  try {
    const taskFile = path.join(root, 'task.md');
    await writeFile(taskFile, '# Task\n');

    const body = await buildDraftPrBody(
      makeRun({ taskFile }),
      [
        '# TAT-3344 — [Core] order 0: insufficient margin to place order',
        '',
        '**Branch:** `TAT-3344-fix-core-order-0-insufficient-marg`',
        '**Commit:** `98903d27a` — `fix(perps): size max order amount`',
        '',
        '## Summary',
        '',
        'Max-size market buys now reserve slippage.',
        '',
        '## Root cause',
        '',
        'Sizing used the mid price instead of the submitted price.',
      ].join('\n'),
      [],
    );

    assert.match(body, /^## Summary\n\nMax-size market buys now reserve slippage\./);
    assert.doesNotMatch(body, /TAT-3344 —/);
    assert.doesNotMatch(body, /\*\*Branch:\*\*/);
    assert.doesNotMatch(body, /\*\*Commit:\*\*/);
    assert.equal(body.match(/^## Summary$/gm)?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
