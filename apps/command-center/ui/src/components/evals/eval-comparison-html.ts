import {
  EVAL_BENCH_TABS,
  type EvalBenchComparison,
  evalBenchCostSaving,
  type EvalBenchPatch,
  type EvalBenchTab,
  type EvalBenchUsage,
} from '@farmslot/protocol';

export const EVAL_COMPARISON_TABS = EVAL_BENCH_TABS;
export type EvalComparisonTab = EvalBenchTab;

function escape(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function number(value: number | null | undefined): string {
  return value == null
    ? 'Not captured'
    : value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}
function money(value: number | null | undefined): string {
  return value == null ? 'Unmetered' : `$${value.toFixed(4)}`;
}
function row(label: string, original: string, trials: string[]): string {
  return `<tr><th scope="row">${escape(label)}</th><td class="original-col">${original}</td>${trials.map((v) => `<td>${v}</td>`).join('')}</tr>`;
}
function usageCell(usage: EvalBenchUsage | undefined, field: keyof EvalBenchUsage): string {
  const value = usage?.[field];
  return escape(
    field === 'costUsd' ? money(usage?.costUsd) : number(typeof value === 'number' ? value : null),
  );
}
function patchSummary(patch: EvalBenchPatch): string {
  const t = patch.totals;
  return t
    ? `${patch.files.length} files · +${t.additions} / −${t.deletions}<br />Code ${t.codeLines} / test ${t.testLines} / other ${t.otherLines}`
    : escape(patch.missingReason);
}
function overview(data: EvalBenchComparison): string {
  const trials = data.trials;
  const original = data.original;
  let result = `<header><h2>${escape(data.item)} · Compare outputs</h2><p>Vs pre-review original is the main score. Vs merged and mergeability are separate assessments.</p><p>${escape(data.reference.repo)} · ${escape(data.reference.base || 'Base unavailable')} → ${escape(data.reference.head || 'Original unavailable')}</p></header>`;
  result += `<div class="table-scroll"><table><thead><tr><th>Measure</th><th class="original-col">Pinned original<br />${escape(original?.model ?? 'Pre-review output')}</th>${trials.map((t) => `<th>${escape(t.trial.model)}<br /><small>${escape(t.trial.route)} · ${escape(t.trial.effort)}<br />${escape(t.trial.runId)}</small></th>`).join('')}</tr></thead><tbody>`;
  result += row(
    'Vs pre-review original',
    'Reference',
    trials.map((t) =>
      escape(t.trial.unscored ? `Unscored: ${t.trial.unscored}` : (t.trial.verdict ?? 'Unjudged')),
    ),
  );
  result += row(
    'Vs merged',
    `PR ${escape(data.reference.pr ?? 'unavailable')}`,
    trials.map((t) => escape(t.trial.verdictVsMerged ?? 'Unjudged')),
  );
  result += row(
    'Mergeability',
    'Not assessed',
    trials.map((t) =>
      escape(t.trial.unscored ? 'Unscored' : (t.trial.mergeable ?? 'Not assessed')),
    ),
  );
  result += row(
    'Recorded cost USD',
    original ? money(original.usage.costUsd) : 'Not captured',
    trials.map((t) => money(t.trial.usage.costUsd)),
  );
  result += row(
    'Cost vs original',
    'Reference',
    trials.map((t) => {
      const saving = evalBenchCostSaving(t.trial);
      return saving === null
        ? 'Not comparable'
        : `${Math.abs(saving * 100).toFixed(1)}% ${saving >= 0 ? 'cheaper' : 'more expensive'}`;
    }),
  );
  for (const [label, field] of [
    ['Input tokens', 'inputTokens'],
    ['Output tokens', 'outputTokens'],
    ['Cache read tokens', 'cacheReadTokens'],
    ['Cache write tokens', 'cacheWriteTokens'],
    ['Reasoning tokens', 'reasoningTokens'],
    ['Turns', 'turns'],
    ['Wall minutes', 'wallMinutes'],
  ] as const)
    result += row(
      label,
      usageCell(original?.usage, field),
      trials.map((t) => usageCell(t.trial.usage, field)),
    );
  result += row(
    'Patch / changed lines',
    patchSummary(data.originalPatch),
    trials.map((t) => patchSummary(t.patch)),
  );
  result += row(
    'Judge AC claim',
    'Not captured',
    trials.map((t) => escape(t.acClaim ?? 'Not assessed')),
  );
  result += row(
    'Ledger proof',
    'Not joined',
    trials.map((t) =>
      t.coverageNote
        ? escape(t.coverageNote)
        : `${t.criteria.length} recorded criteria; inspect their text and evidence below`,
    ),
  );
  result += row(
    'Gate behavior',
    'Not captured',
    trials.map((t) => escape(t.gate ?? 'Not captured')),
  );
  result += '</tbody></table></div>';
  result += `<p>Token counters retain provider semantics; cache and reasoning may overlap other counters. Prices are estimates when reported; unmetered is not $0. Changed-line counts include added and removed lines in retained text patches.</p>`;
  if (original)
    result += `<details><summary>Original usage provenance</summary><p>${escape(original.scope)}<br />${escape(original.startedAt)} to ${escape(original.completedAt)}<br />${escape(original.usage.costNote)}<br />Run ${escape(original.runId)}<br />Source SHA-256 ${escape(original.sourceSha256)}</p></details>`;
  return result;
}
function section(title: string, body: string): string {
  return `<section><h3>${escape(title)}</h3>${body}</section>`;
}
function pre(value: string | null | undefined): string {
  return `<pre>${escape(value ?? 'Not available')}</pre>`;
}
function patchText(patch: EvalBenchPatch, file: string): string | null {
  if (patch.text === null) return patch.missingReason;
  return file
    ? (patch.files.find((f) => f.path === file)?.text ??
        'This output does not change the selected file.')
    : (patch.text ?? patch.missingReason);
}
function patches(data: EvalBenchComparison, file: string): string {
  return (
    section(
      'Retained patches',
      `<div class="columns"><article class="original-panel"><h4>Pre-review original</h4>${pre(patchText(data.originalPatch, file))}</article>${data.trials.map((t) => `<article><h4>${escape(t.trial.model)}</h4>${pre(patchText(t.patch, file))}</article>`).join('')}</div>`,
    ) +
    data.trials
      .map((t) => {
        const selected = file ? t.fileComparisons?.find((f) => f.path === file) : null;
        const diff = file ? (selected?.diffOfDiffs ?? null) : t.diffOfDiffs;
        const note = file
          ? (selected?.note ??
            (selected
              ? 'Both file patches use the verified original base.'
              : 'Selected file comparison is unavailable; refresh the snapshot.'))
          : (t.comparisonNote ?? 'Both patches use the verified original base.');
        return section(
          `${t.trial.model}: diff-of-diffs vs original${file ? ` · ${file}` : ''}`,
          `<p>${escape(note)}</p>${pre(diff)}`,
        );
      })
      .join('')
  );
}
function files(data: EvalBenchComparison): string {
  const outputs = [
    { label: 'Pre-review original', patch: data.originalPatch },
    ...data.trials.map((t) => ({ label: t.trial.model, patch: t.patch })),
  ];
  return section(
    'Files touched',
    outputs
      .map(
        (o) =>
          `<article><h4>${escape(o.label)}</h4>${o.patch.missingReason ? `<p>${escape(o.patch.missingReason)}</p>` : `<table><thead><tr><th>File</th><th>Kind</th><th>Added</th><th>Removed</th></tr></thead><tbody>${o.patch.files.map((f) => `<tr><td>${escape(f.path)}</td><td>${escape(f.kind)}</td><td>${f.additions}</td><td>${f.deletions}</td></tr>`).join('')}</tbody></table>`}</article>`,
      )
      .join(''),
  );
}
function acceptance(data: EvalBenchComparison): string {
  return section(
    'Acceptance evidence',
    `<p>A judge's AC count is a claim. A generic ledger criterion does not prove each task AC. Verdicts below are retained assertions, not a new assessment.</p>${data.trials.map((t) => `<article><h4>${escape(t.trial.model)} · judge claim ${escape(t.acClaim ?? 'Not assessed')}</h4>${t.coverageNote ? `<p>${escape(t.coverageNote)}</p>` : `<table><thead><tr><th>Criterion</th><th>Retained verdict</th><th>Evidence</th></tr></thead><tbody>${t.criteria.map((c) => `<tr><td>${escape(c.id)}: ${escape(c.text)}</td><td>${escape(c.verdict)}<br />${escape(c.proofMode ?? 'Proof mode not recorded')}<br />${escape(c.timing ?? 'Timing not recorded')}</td><td>${c.evidence.map(escape).join('<br />')}</td></tr>`).join('')}</tbody></table>`}</article>`).join('')}`,
  );
}
function findings(data: EvalBenchComparison): string {
  return section(
    'Judge findings',
    data.trials
      .map(
        (t) =>
          `<article><h4>${escape(t.trial.model)}</h4><details><summary>Judgment context vs original and merged</summary><h5>Gaps vs pre-review original</h5>${list(t.originalGaps, 'Not recorded')}<h5>Ahead of original</h5>${list(t.aheadOfOriginal, 'Not recorded')}<h5>Gaps vs merged</h5>${list(t.mergedGaps, 'Not recorded')}<h5>What review fixed in the original</h5>${list(t.fixedByOriginalReview, 'Not recorded')}</details>${t.findings.length ? `<table><thead><tr><th>Severity / cause</th><th>Finding</th><th>Shared with original</th><th>Evidence</th></tr></thead><tbody>${t.findings.map((f) => `<tr><td>${escape(f.severity)}<br />${escape(f.cause ?? 'Unknown cause')}</td><td>${escape(f.text)}</td><td>${f.sharedWithOriginal === null ? 'Not recorded' : f.sharedWithOriginal ? 'Yes' : 'No'}</td><td>${escape(f.evidence ?? 'Not recorded')}</td></tr>`).join('')}</tbody></table>` : '<p>No findings recorded.</p>'}</article>`,
      )
      .join(''),
  );
}
function list(values: string[], empty: string): string {
  return values.length
    ? `<ul>${values.map((v) => `<li>${escape(v)}</li>`).join('')}</ul>`
    : `<p>${escape(empty)}</p>`;
}
function drift(data: EvalBenchComparison): string {
  return section(
    'Scope, process and gate behavior',
    `<p>File differences are scope signals, not automatic failures. Invented links and process deviations remain the judge's findings with their cited evidence.</p>${data.trials.map((t) => `<article><h4>${escape(t.trial.model)}</h4><p>Gate: ${escape(t.gate ?? 'Not captured')}</p><h5>Files outside original scope</h5>${t.patch.text === null || data.originalPatch.text === null ? '<p>Scope comparison unavailable without both retained patches.</p>' : list(t.extraFiles, 'No extra files in retained patches.')}<h5>Original files absent from this output</h5>${t.patch.text === null || data.originalPatch.text === null ? '<p>Scope comparison unavailable without both retained patches.</p>' : list(t.missingFiles, 'No missing files in retained patches.')}<h5>Baseline proof</h5><p>Tests: ${t.redFirst?.tests == null ? 'Not recorded' : t.redFirst.tests ? 'Red first reported' : 'Not red first'}; recipe: ${t.redFirst?.recipe == null ? 'Not recorded' : t.redFirst.recipe ? 'Red baseline reported' : 'No valid red baseline reported'}</p><p>${escape(t.redFirst?.how ?? 'Not recorded')}</p><h5>Retained drift notes</h5>${list(t.driftNotes, 'No drift notes recorded.')}</article>`).join('')}`,
  );
}
export function renderEvalComparisonBody(
  data: EvalBenchComparison,
  tab: EvalComparisonTab | 'all' = 'all',
  file = '',
): string {
  const sections = {
    patches: () => patches(data, file),
    files: () => files(data),
    acceptance: () => acceptance(data),
    findings: () => findings(data),
    drift: () => drift(data),
  };
  return `<div class="comparison-content">${overview(data)}${tab === 'all' ? EVAL_COMPARISON_TABS.map((t) => sections[t]()).join('') : sections[tab]()}<details><summary>Snapshot identity</summary><p>Captured ${escape(data.capturedAt)}<br />Dataset ${escape(data.dataset)}<br />Original patch SHA-256 ${escape(data.originalPatch.sha256 ?? 'Unavailable')}</p>${data.trials.map((t) => `<p>${escape(t.trial.runId)}<br />Record SHA-256 ${escape(t.trial.sourceSha256)}<br />Patch SHA-256 ${escape(t.patch.sha256 ?? 'Unavailable')}<br />Candidate base ${escape(t.candidateBase ?? 'Unavailable')}</p>`).join('')}</details></div>`;
}

export const EVAL_COMPARISON_CSS = `
.comparison-content{color:#e0e0e8;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;min-width:0;overflow-wrap:anywhere}
.comparison-content section,.comparison-content header{margin:16px 0;padding:14px;background:#12121a;border:1px solid #303046;border-radius:6px;min-width:0}
.comparison-content h2,.comparison-content h3,.comparison-content h4{color:#e0e0e8;margin:0 0 10px}
.comparison-content p,.comparison-content small{color:#a0a0b4}.comparison-content .table-scroll{overflow-x:auto}
.comparison-content table{border-collapse:collapse;width:100%}.comparison-content th,.comparison-content td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid #303046;min-width:150px}
.comparison-content .original-col{position:sticky;left:0;z-index:1;min-width:220px;max-width:280px;background:#202036;color:#c7c7ff}
.comparison-content article{min-width:0;margin:12px 0;overflow-x:auto}.comparison-content pre{white-space:pre;overflow:auto;max-height:520px;padding:12px;background:#0a0a0f;color:#d0d0dc;font:12px/1.6 ui-monospace,monospace}
.comparison-content .columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:12px}.comparison-content details{padding:10px;border:1px solid #303046;margin-top:12px}
@media(max-width:600px){.comparison-content th,.comparison-content td{min-width:120px}.comparison-content .original-col{min-width:120px;max-width:140px}}
`;

export function exportEvalComparisonHtml(data: EvalBenchComparison): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(data.item)} comparison</title><style>body{margin:0;padding:20px;background:#0a0a0f}${EVAL_COMPARISON_CSS}</style></head><body>${renderEvalComparisonBody(data)}</body></html>`;
}
