import { html, LitElement } from 'lit';
import { customElement } from 'lit/decorators.js';

import type { TaskSchema } from '@farmslot/protocol';

import '../components/config/config-panel.js';
import '../components/config/template-schema.js';
import '../components/config/slot-toggle.js';

import { colors, fonts, spacing } from '../styles/theme-tokens.js';

const mockSchema: TaskSchema = {
  flowType: 'fix-bug',
  title: 'Fix Bug',
  totalSteps: 8,
  phases: [
    {
      name: 'Investigate',
      steps: [
        { index: 1, name: 'Read the ticket description and acceptance criteria' },
        { index: 2, name: 'Identify affected files using {{JIRA}} context' },
        { index: 3, name: 'Create branch {{BRANCH}} and draft PR' },
      ],
    },
    {
      name: 'Implement',
      steps: [
        { index: 4, name: 'Apply the fix' },
        { index: 5, name: 'Run tests: {{TEST_CMD}}' },
      ],
    },
    {
      name: 'Validate',
      steps: [
        { index: 6, name: 'Verify fix via CDP on port {{port}}' },
        { index: 7, name: 'Record video evidence' },
        { index: 8, name: 'Write report' },
      ],
    },
  ],
};

const mockPlaceholders = ['JIRA', 'BRANCH', 'TEST_CMD', 'port'];

@customElement('config-dev')
export class ConfigDev extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <style>
        config-dev {
          display: block;
          padding: ${spacing.lg};
          font-family: ${fonts.mono};
        }
        config-dev h3 {
          color: ${colors.textPrimary};
          margin: 0 0 ${spacing.md} 0;
          font-size: ${fonts.sizeLg};
        }
        config-dev .section {
          margin-bottom: ${spacing.xxl};
        }
        config-dev .section-label {
          font-size: ${fonts.sizeSm};
          color: ${colors.textMuted};
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: ${spacing.md};
        }
      </style>

      <div class="section">
        <p class="section-label">
          Template Schema (mock fix-bug, 3 phases, 8 steps, 4 placeholders)
        </p>
        <div
          style="max-width: 600px; background: ${colors.bgSurface}; border-radius: 8px; padding: ${spacing.lg};"
        >
          <template-schema
            .schema=${mockSchema}
            .placeholders=${mockPlaceholders}
          ></template-schema>
        </div>
      </div>

      <div class="section">
        <p class="section-label">Slot Toggle variants</p>
        <div
          style="display: flex; gap: ${spacing.xl}; align-items: center; padding: ${spacing.md}; background: ${colors.bgCard}; border-radius: 8px; max-width: 400px;"
        >
          <div style="color: ${colors.textSecondary}; font-size: ${fonts.sizeSm};">
            <span>Enabled:</span>
            <slot-toggle slotId="demo-1" enabled mode="dispatch" lifecycle="ready"></slot-toggle>
          </div>
          <div style="color: ${colors.textSecondary}; font-size: ${fonts.sizeSm};">
            <span>Disabled:</span>
            <slot-toggle slotId="demo-2" mode="disabled" lifecycle="disabled"></slot-toggle>
          </div>
          <div style="color: ${colors.textSecondary}; font-size: ${fonts.sizeSm};">
            <span>Locked:</span>
            <slot-toggle slotId="demo-3" enabled mode="dispatch" lifecycle="working"></slot-toggle>
          </div>
        </div>
      </div>

      <div class="section">
        <p class="section-label">Config Panel (requires live gateway)</p>
        <div
          style="height: calc(100vh - 400px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden;"
        >
          <config-panel></config-panel>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'config-dev': ConfigDev;
  }
}
