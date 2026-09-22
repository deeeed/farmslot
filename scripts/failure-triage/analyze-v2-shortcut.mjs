// Deterministic slot-ownership shortcut comparator for the failure-triage v2 corpus.
//
// Purpose: make the B1 review finding reproducible. This is a review artifact, NOT a
// baseline for the frozen pilot gate. It was authored AFTER seeing v2 held-out results,
// so adding it to triageGate would be post-hoc tuning. It exists only to show that a
// trivial rule reading v2's structured state matches or beats the live candidate, and
// therefore that the recorded macro-F1 gain over the two frozen v1 text classifiers
// measures corpus-format mismatch rather than model capability.
//
// No provider calls, no network, no writes outside the output path.
//
// Usage: node scripts/failure-triage/analyze-v2-shortcut.mjs <new-output.json> [repo-root]

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
assert.ok(OUT, 'Provide a new output file');
const ROOT = process.argv[3] ?? process.cwd();
const CORPUS_PATH = path.join(ROOT, 'scripts/failure-triage/corpus-v2.json');

// Pinned so the artifact cannot silently score a different corpus.
const EXPECTED_CORPUS_HASH = 'f678519daa6c014922e1f89a046ec22e4985cb2d1a2155047674e781c3d13d62';

const bytes = readFileSync(CORPUS_PATH, 'utf8');
const corpusHash = createHash('sha256').update(bytes).digest('hex');
assert.equal(corpusHash, EXPECTED_CORPUS_HASH, 'Corpus bytes differ from the audited v2 draft');
const corpus = JSON.parse(bytes);

// Same label order as services/gateway/src/assessment/failure-triage/types.ts LABELS.
const LAB = [
  'environment',
  'dependencies',
  'implementation',
  'test_harness',
  'missing_evidence',
  'external_service',
  'unclear',
];

/**
 * The shortcut: read the one populated component slot out of the serialized fixture
 * state that ships inside the provider packet. No text matching, no model.
 */
function predict(x) {
  let st = null;
  for (const e of x.packet.evidence) {
    try {
      const p = JSON.parse(e.text);
      if (p && p.program !== undefined) st = p;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Evidence entries that are not the serialized fixture state (plain failure output)
      // are intentionally ignored; only the state blob carries slot ownership.
    }
  }
  if (!st) return 'unclear';
  if (st.upstream && Object.keys(st.upstream).length) return 'external_service';
  if (st.proof && Object.keys(st.proof).length) return 'missing_evidence';
  if (st.dependency && Object.keys(st.dependency).length) return 'dependencies';
  if (st.env && Object.keys(st.env).length) return 'environment';
  return 'implementation';
}

// Macro-F1 mirrors metrics.ts: per-label 2tp / (2tp + fp + fn), averaged over all 7 labels.
// This rule always emits a label, so there is no 'unavailable' column to account for.
function score(cases) {
  const conf = {};
  for (const a of LAB) {
    conf[a] = {};
    for (const b of LAB) conf[a][b] = 0;
  }
  let ok = 0;
  const predictions = [];
  for (const x of cases) {
    const p = predict(x);
    conf[x.reference.label][p]++;
    if (p === x.reference.label) ok++;
    predictions.push({
      id: x.id,
      reference: x.reference.label,
      predicted: p,
      correct: p === x.reference.label,
    });
  }
  const perLabelF1 = LAB.map((l) => {
    const tp = conf[l][l];
    const fp = LAB.filter((o) => o !== l).reduce((s, o) => s + conf[o][l], 0);
    const fn = LAB.filter((o) => o !== l).reduce((s, o) => s + conf[l][o], 0);
    return 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : 0;
  });
  return {
    cases: cases.length,
    correct: ok,
    correctOfCases: `${ok}/${cases.length}`,
    accuracy: ok / cases.length,
    macroF1: perLabelF1.reduce((a, b) => a + b, 0) / LAB.length,
    perLabelF1: Object.fromEntries(LAB.map((l, i) => [l, perLabelF1[i]])),
    confusion: conf,
    predictions,
  };
}

const heldOut = score(corpus.cases.filter((c) => c.split === 'held-out'));
const development = score(corpus.cases.filter((c) => c.split === 'development'));

// Recorded live candidate and frozen baselines, read from the immutable receipts.
const receipt = JSON.parse(
  readFileSync(
    path.join(ROOT, 'scripts/failure-triage/results/v2-held-out/evaluation.json'),
    'utf8',
  ),
);

const result = {
  artifact: 'slot-ownership-shortcut-comparator',
  purpose:
    'Reproduce review finding B1: a trivial deterministic rule over v2 structured state matches or beats the live candidate, so the recorded macro-F1 gain over the frozen v1 text classifiers is not evidence of model capability.',
  postHoc: true,
  notAGateBaseline: true,
  providerCalls: 0,
  findingRaisedAtSha: 'f80adaf3ecd727acc91908fdde28b17f60c670ef',
  corpusHash,
  slotRule: {
    'no serialized fixture state in evidence': 'unclear',
    'upstream populated': 'external_service',
    'proof populated': 'missing_evidence',
    'dependency populated': 'dependencies',
    'env populated': 'environment',
    otherwise: 'implementation',
  },
  heldOut,
  development,
  comparisonHeldOut: {
    slotShortcut: { correct: heldOut.correctOfCases, macroF1: heldOut.macroF1 },
    liveCandidate: {
      correct: `${receipt.metrics.correct}/${receipt.metrics.cases}`,
      macroF1: receipt.metrics.macroF1,
    },
    frozenCueSheet: {
      correct: `${receipt.baselines.diagnosticCueSheet.correct}/${receipt.metrics.cases}`,
      macroF1: receipt.baselines.diagnosticCueSheet.macroF1,
    },
    frozenExistingClassifier: {
      correct: `${receipt.baselines.deterministic.correct}/${receipt.metrics.cases}`,
      macroF1: receipt.baselines.deterministic.macroF1,
    },
    shortcutBeatsCandidate:
      heldOut.correct > receipt.metrics.correct && heldOut.macroF1 > receipt.metrics.macroF1,
  },
};

writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify(
    {
      corpusHash,
      heldOut: { correct: heldOut.correctOfCases, macroF1: heldOut.macroF1 },
      development: { correct: development.correctOfCases, macroF1: development.macroF1 },
      liveCandidateHeldOut: {
        correct: `${receipt.metrics.correct}/${receipt.metrics.cases}`,
        macroF1: receipt.metrics.macroF1,
      },
      shortcutBeatsCandidate: result.comparisonHeldOut.shortcutBeatsCandidate,
      out: OUT,
    },
    null,
    2,
  ),
);
