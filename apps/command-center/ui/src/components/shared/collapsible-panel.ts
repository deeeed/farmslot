import { html, nothing, type TemplateResult } from 'lit';

import { viewToggleField } from '@farmslot/protocol';

import { browserViewState, viewStateUpdates } from '../../utils/view-state.js';

import { renderCollapsibleSectionHeader } from './collapsible-section-header.js';

/** Every panel header is this tall, open or closed, so a toggle never moves what is above it. */
export const COLLAPSIBLE_PANEL_HEADER_HEIGHT = '44px';

export function collapsiblePanelOpen(panelId: string, defaultOpen: boolean): boolean {
  return browserViewState.get(viewToggleField('panels', panelId, defaultOpen));
}

export function rememberCollapsiblePanel(
  panelId: string,
  open: boolean,
  defaultOpen: boolean,
): void {
  browserViewState.set(viewToggleField('panels', panelId, defaultOpen), open);
}

export function toggleCollapsiblePanel(panelId: string, defaultOpen: boolean): boolean {
  const open = !collapsiblePanelOpen(panelId, defaultOpen);
  rememberCollapsiblePanel(panelId, open, defaultOpen);
  return open;
}

export interface CollapsiblePanelOptions {
  id: string;
  label: string;
  /** Shown beside the label, e.g. `12` for "Artifacts (12)". */
  summary?: string;
  open: boolean;
  onToggle: () => void;
  /** Rendered only while the panel is open. */
  body: () => unknown;
  disabled?: boolean;
  title?: string;
  /** Header test id; defaults to `<id>-toggle`. */
  testId?: string;
  /** Extra header classes. */
  className?: string;
}

/** A panel with a fixed-height header that shows or hides its body. */
export function renderCollapsiblePanel(options: CollapsiblePanelOptions): TemplateResult {
  return html`${viewStateUpdates()}
    <section
      data-panel="${options.id}"
      data-open="${options.open ? 'true' : 'false'}"
      style="display:block; min-width:0;"
    >
      ${renderCollapsibleSectionHeader(options.label, !options.open, options.onToggle, {
        testId: options.testId ?? `${options.id}-toggle`,
        className: options.className,
        disabled: options.disabled,
        title: options.title,
        summary: options.summary,
        height: COLLAPSIBLE_PANEL_HEADER_HEIGHT,
      })}
      ${options.open ? options.body() : nothing}
    </section>`;
}
