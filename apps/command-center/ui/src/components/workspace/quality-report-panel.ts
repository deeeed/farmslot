// quality-report-panel.ts — Evidence quality verdict display with click-to-override
// Extracted from review-workspace.ts for maintainability.

import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { EvidenceQualityReport, EvidenceQualityVerdict } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

const VERDICT_COLORS: Record<string, string> = {
  RELEVANT_HIGH: colors.statusOk,
  RELEVANT_LOW: colors.statusWarn,
  IRRELEVANT: colors.statusFail,
  MISSING: colors.textMuted,
};

const VERDICT_ORDER: Record<string, number> = {
  MISSING: 0,
  IRRELEVANT: 1,
  RELEVANT_LOW: 2,
  RELEVANT_HIGH: 3,
};
const VERDICT_CYCLE: EvidenceQualityVerdict[] = [
  'RELEVANT_HIGH',
  'RELEVANT_LOW',
  'IRRELEVANT',
  'MISSING',
];

@customElement('quality-report-panel')
export class QualityReportPanel extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) report: EvidenceQualityReport | null = null;
  @property({ attribute: false }) overrides = new Map<string, string>();

  private _cycleVerdict(ac: string, original: EvidenceQualityVerdict) {
    const current = (this.overrides.get(ac) ?? original) as EvidenceQualityVerdict;
    const idx = VERDICT_CYCLE.indexOf(current);
    const next = VERDICT_CYCLE[(idx + 1) % VERDICT_CYCLE.length];
    const updated = new Map(this.overrides);
    if (next === original) {
      updated.delete(ac);
    } else {
      updated.set(ac, next);
    }
    this.dispatchEvent(new CustomEvent('override-change', { detail: updated }));
  }

  override render() {
    if (!this.report) {
      return html`<div style="padding:12px;color:${colors.textMuted};font-size:12px">
        Quality audit unavailable
      </div>`;
    }

    const score = this.report.overallScore;
    const scoreColor =
      score >= 80 ? colors.statusOk : score >= 50 ? colors.statusWarn : colors.statusFail;

    return html`
      <div style="padding:8px 12px">
        <div style="font-size:12px;color:${colors.textMuted};margin-bottom:8px">
          Evidence Quality — Score: <strong style="color:${scoreColor}">${score}</strong>/100
        </div>
        ${[...this.report.acVerdicts]
          .sort((a, b) => (VERDICT_ORDER[a.verdict] ?? 4) - (VERDICT_ORDER[b.verdict] ?? 4))
          .map((v) => {
            const displayVerdict = this.overrides.get(v.ac) ?? v.verdict;
            const color = VERDICT_COLORS[displayVerdict] ?? colors.textMuted;
            const isOverridden = this.overrides.has(v.ac);
            return html`
              <div
                style="display:flex;align-items:flex-start;gap:8px;padding:4px 0;border-bottom:1px solid ${colors.bgCardHover}"
              >
                <span
                  style="flex-shrink:0;font-size:11px;font-weight:600;padding:2px 6px;border-radius:3px;background:${color}22;color:${color};cursor:pointer"
                  title="Click to override"
                  @click=${() => this._cycleVerdict(v.ac, v.verdict)}
                >
                  ${displayVerdict.replace('_', ' ')}${isOverridden ? ' *' : ''}
                </span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:12px;color:${colors.textPrimary}">${v.ac}</div>
                  <div style="font-size:11px;color:${colors.textMuted};margin-top:2px">
                    ${v.reasoning}
                  </div>
                </div>
              </div>
            `;
          })}
      </div>
    `;
  }
}
