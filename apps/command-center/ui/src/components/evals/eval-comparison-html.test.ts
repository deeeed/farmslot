import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EvalBenchComparison, EvalBenchPatch, EvalBenchTrial } from '@farmslot/protocol';

import { exportEvalComparisonHtml, renderEvalComparisonBody } from './eval-comparison-html.js';

function fixture(): EvalBenchComparison {
  const patch: EvalBenchPatch = {
    text: '+safe',
    sha256: 'patch-hash',
    files: [],
    missingReason: null,
    totals: { additions: 1, deletions: 0, codeLines: 1, testLines: 0, otherLines: 0 },
  };
  const trial: EvalBenchTrial = {
    runId: 'trial',
    sourceSha256: 'record-hash',
    dataset: 'dataset',
    item: 'case',
    problemType: 'fix-bug',
    area: 'Core',
    sizeClass: 'small',
    model: 'Candidate',
    modelId: 'candidate',
    route: 'hosted',
    effort: 'high',
    reference: { repo: 'owner/repo', base: 'base', head: 'original', pr: 1 },
    verdict: 'ACCEPTABLE-ALT',
    verdictVsMerged: 'PARTIAL',
    mergeable: 'no: needs changes',
    unscored: null,
    original: null,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      turns: 3,
      costUsd: null,
      costNote: 'Unknown price',
      wallMinutes: 2,
    },
  };
  return {
    capturedAt: '2026-01-01T00:00:00Z',
    dataset: 'dataset',
    item: 'case',
    reference: trial.reference,
    original: null,
    originalPatch: patch,
    trials: [
      {
        trial,
        patch,
        candidateBase: 'base',
        diffOfDiffs: '+delta',
        fileComparisons: [],
        comparisonNote: null,
        extraFiles: [],
        missingFiles: [],
        criteria: [
          {
            id: 'AC-1',
            text: 'One generic criterion',
            verdict: 'proven',
            evidence: ['trace.json'],
            proofMode: 'state',
            timing: 'outside-recording',
          },
        ],
        coverageNote: null,
        acClaim: '5/5',
        template: 'fix-bug/project',
        originalGaps: [],
        aheadOfOriginal: [],
        mergedGaps: [],
        fixedByOriginalReview: [],
        findings: [],
        driftNotes: [],
        gate: 'n/a',
        redFirst: null,
      },
    ],
  };
}

test('HTML snapshot is self-contained, inert and escapes record, finding, patch and title text', () => {
  const data = fixture();
  const attack =
    '</title><script>throw 1</script><img src="https://invalid.example/x" onerror="throw 2">';
  data.item = attack;
  data.trials[0].patch.text = attack;
  data.trials[0].findings.push({
    severity: 'minor',
    text: attack,
    cause: 'model',
    evidence: attack,
    sharedWithOriginal: false,
  });
  const html = exportEvalComparisonHtml(data);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script\b|<img\b|<link\b|<iframe\b/i);
  assert(!/@import|url\(/i.test(html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=&quot;/);
  assert.match(html, /Unmetered/);
  assert.doesNotMatch(html, /\$0\.0000/);
  for (const section of [
    'Retained patches',
    'Files touched',
    'Acceptance evidence',
    'Judge findings',
    'Scope, process and gate behavior',
  ])
    assert.ok(html.includes(section));
});

test('primary, merged and acceptance claims remain distinct; missing patches do not become scope passes', () => {
  const data = fixture();
  const body = renderEvalComparisonBody(data, 'acceptance');
  assert.match(body, /ACCEPTABLE-ALT/);
  assert.match(body, /PARTIAL/);
  assert.match(body, /judge claim 5\/5/);
  assert.match(body, /One generic criterion/);
  assert.match(body, /not prove each task AC/);
  data.originalPatch = {
    text: null,
    sha256: null,
    files: [],
    totals: null,
    missingReason: 'Missing original',
  };
  const drift = renderEvalComparisonBody(data, 'drift');
  assert.match(drift, /Scope comparison unavailable/);
  assert.doesNotMatch(drift, /No extra files in retained patches/);
});
