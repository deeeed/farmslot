import { html } from 'lit';

import { radii, spacing } from '../../styles/theme-tokens.js';

/** A gate action that needs a written reason: title, why, the reason, confirm and cancel. */
export interface ReasonSheetInput {
  title: string;
  hint: string;
  label: string;
  placeholder: string;
  value: string;
  confirmLabel: string;
  cancelLabel: string;
  canConfirm: boolean;
  busy?: boolean;
  /** Prefix of the sheet's test ids: `<id>-reason`, `<id>-confirm`, `<id>-cancel`. */
  testId: string;
  change: (value: string) => void;
  confirm: () => void;
  cancel: () => void;
}

/** The one reason sheet the gate's criterion and review actions share. */
export function renderReasonSheet(input: ReasonSheetInput) {
  return html`<section class="reason-sheet" aria-label=${input.title}>
    <strong>${input.title}</strong>
    <p>${input.hint}</p>
    <label
      >${input.label}
      <textarea
        data-testid=${`${input.testId}-reason`}
        rows="3"
        placeholder=${input.placeholder}
        .value=${input.value}
        ?disabled=${input.busy}
        @input=${(event: Event) => input.change((event.target as HTMLTextAreaElement).value)}
      ></textarea>
    </label>
    <div class="reason-sheet-actions">
      <button
        type="button"
        class="gate-primary"
        data-testid=${`${input.testId}-confirm`}
        ?disabled=${input.busy || !input.canConfirm}
        @click=${input.confirm}
      >
        ${input.confirmLabel}
      </button>
      <button
        type="button"
        class="gate-secondary"
        data-testid=${`${input.testId}-cancel`}
        ?disabled=${input.busy}
        @click=${input.cancel}
      >
        ${input.cancelLabel}
      </button>
    </div>
  </section>`;
}

/** Styles over the publication gate's colors, in the gate and in run detail's criteria. */
export function reasonSheetStyles(): string {
  return `
    .reason-sheet { display: grid; gap: ${spacing.md}; max-width: 640px; margin-top: ${spacing.sm}; padding: ${spacing.lg}; color: var(--gate-text); border: 1px solid var(--gate-border); border-radius: ${radii.md}; background: var(--gate-surface); }
    .reason-sheet p { margin: 0; color: var(--gate-secondary); }
    .reason-sheet label { display: grid; gap: ${spacing.sm}; font-weight: 600; }
    .reason-sheet textarea { font: inherit; min-height: 64px; padding: ${spacing.md}; color: var(--gate-text); background: var(--gate-background); border: 1px solid var(--gate-border); border-radius: ${radii.md}; resize: vertical; }
    .reason-sheet-actions { display: flex; flex-wrap: wrap; gap: ${spacing.sm}; }
    .reason-sheet .gate-primary, .reason-sheet .gate-secondary { min-height: 44px; min-width: 44px; font: inherit; font-weight: 600; padding: ${spacing.md} ${spacing.lg}; border-radius: ${radii.md}; cursor: pointer; }
    .reason-sheet .gate-primary { border: 1px solid var(--gate-accent); background: var(--gate-accent); color: var(--gate-onAccent); }
    .reason-sheet .gate-secondary { border: 1px solid var(--gate-border); background: var(--gate-surface); color: var(--gate-text); }
    .reason-sheet button:disabled { opacity: 0.65; cursor: not-allowed; }
  `;
}
