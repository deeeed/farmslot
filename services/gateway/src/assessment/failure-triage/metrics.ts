import { wilsonInterval } from '../evaluation.js';

import { LABELS, type TriageCase, type TriageResult } from './types.js';

export function triageMetrics(
  cases: TriageCase[],
  results: TriageResult[],
  corpusCases: TriageCase[] = cases,
) {
  const byId = new Map(results.map((r) => [r.caseId, r]));
  if (byId.size !== results.length)
    throw new Error('Repeated attempts cannot be scored as independent cases');
  const predicted = [...LABELS, 'unavailable'] as const;
  const confusion = Object.fromEntries(
    LABELS.map((label) => [label, Object.fromEntries(predicted.map((p) => [p, 0]))]),
  );
  let correct = 0,
    definite = 0,
    definiteCorrect = 0,
    definiteOnDefinite = 0,
    correctAbstentions = 0,
    confidentWrong = 0,
    nextCheckCorrect = 0,
    validEvidence = 0;
  for (const c of cases) {
    const r = byId.get(c.id),
      p = r?.status === 'completed' ? r.prediction : undefined;
    confusion[c.reference.label][p?.label ?? 'unavailable']++;
    if (p?.label === c.reference.label) correct++;
    if (p?.nextCheck === c.reference.nextCheck) nextCheckCorrect++;
    if (p && p.evidenceIds.every((id) => c.packet.evidence.some((e) => e.id === id)))
      validEvidence++;
    if (p && p.label !== 'unclear') {
      definite++;
      if (p.label === c.reference.label) definiteCorrect++;
      if (c.reference.label !== 'unclear') definiteOnDefinite++;
      if (p.label !== c.reference.label && (p.confidence ?? 0) >= 0.85) confidentWrong++;
    }
    if (c.reference.label === 'unclear' && p?.label === 'unclear') correctAbstentions++;
  }
  const definiteCases = cases.filter((c) => c.reference.label !== 'unclear').length;
  const unclearCases = cases.length - definiteCases;
  const f1 = LABELS.map((label) => {
    const tp = confusion[label][label];
    const fp = LABELS.filter((other) => other !== label).reduce(
      (sum, other) => sum + confusion[other][label],
      0,
    );
    const fn = Object.entries(confusion[label])
      .filter(([p]) => p !== label)
      .reduce((sum, [, n]) => sum + n, 0);
    return 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : 0;
  });
  const completed = cases.filter((c) => byId.get(c.id)?.status === 'completed').length;
  const families = [...new Set(cases.map((c) => c.group))];
  // Subset evaluation inherits the full corpus's dependence, even for one selected case.
  const correlated = new Set(corpusCases.map((c) => c.group)).size !== corpusCases.length;
  const familyAccuracy = families.map((group) => {
    const members = cases.filter((c) => c.group === group);
    return (
      members.filter((c) => {
        const r = byId.get(c.id);
        return r?.status === 'completed' && r.prediction?.label === c.reference.label;
      }).length / members.length
    );
  });
  return {
    cases: cases.length,
    families: families.length,
    familiesByLabel: Object.fromEntries(
      LABELS.map((label) => [
        label,
        new Set(cases.filter((c) => c.reference.label === label).map((c) => c.group)).size,
      ]),
    ),
    familyWeightedAccuracy: familyAccuracy.length
      ? familyAccuracy.reduce((a, b) => a + b, 0) / familyAccuracy.length
      : null,
    uncertainty: correlated
      ? 'Correlated synthetic variants; population confidence intervals unsupported'
      : 'Case-level Wilson intervals assume independent observations',
    completed,
    unavailable: cases.length - completed,
    correct,
    accuracy: cases.length ? correct / cases.length : null,
    accuracyInterval95: correlated ? null : wilsonInterval(correct, cases.length),
    macroF1: f1.reduce((sum, n) => sum + n, 0) / LABELS.length,
    definiteAnswers: definite,
    definiteCorrect,
    definitePrecision: definite ? definiteCorrect / definite : null,
    definitePrecisionInterval95: correlated ? null : wilsonInterval(definiteCorrect, definite),
    definiteCases,
    definiteOnDefinite,
    definiteCoverage: definiteCases ? definiteOnDefinite / definiteCases : null,
    unclearCases,
    correctAbstentions,
    definiteOnUnclear: cases.filter(
      (c) =>
        c.reference.label === 'unclear' &&
        byId.get(c.id)?.status === 'completed' &&
        byId.get(c.id)?.prediction?.label !== 'unclear',
    ).length,
    confidentWrong,
    nextCheckCorrect,
    validEvidence,
    confusion,
  };
}
export function triageGate(params: {
  liveStatus: string;
  corpusIntegrityPassed: boolean;
  metrics: ReturnType<typeof triageMetrics>;
  baseline: ReturnType<typeof triageMetrics>;
  cueSheet: ReturnType<typeof triageMetrics>;
  violations: number;
  withinBudget: boolean;
}) {
  const { liveStatus, metrics: m, baseline, cueSheet, violations, withinBudget } = params;
  const checks = [
    { id: 'corpus-integrity-reviewed', passed: params.corpusIntegrityPassed === true },
    {
      id: 'complete-live-held-out',
      passed: liveStatus === 'completed' && m.cases === 21 && m.completed === 21,
    },
    { id: 'no-data-secret-authority-violations', passed: violations === 0 },
    {
      id: 'unclear-cases-abstain',
      passed: m.unclearCases === 3 && m.correctAbstentions === 3 && m.definiteOnUnclear === 0,
    },
    {
      id: 'definite-precision-0.85',
      passed: m.definitePrecision !== null && m.definitePrecision >= 0.85,
    },
    {
      id: 'definite-coverage-0.60',
      passed: m.definiteCoverage !== null && m.definiteCoverage >= 0.6,
    },
    {
      id: 'macro-f1-gain-0.05',
      passed: m.macroF1 - Math.max(baseline.macroF1, cueSheet.macroF1) >= 0.05 - 1e-12,
    },
    { id: 'within-budget', passed: withinBudget },
  ];
  return {
    eligible: checks.every((c) => c.passed),
    checks,
    decision: checks.every((c) => c.passed) ? ('pilot' as const) : ('hold' as const),
  };
}
export function percentiles(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95) };
}
