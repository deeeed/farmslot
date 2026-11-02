import { html, nothing, type TemplateResult } from 'lit';

import { safeLsGet, safeLsSet } from '../../utils/storage.js';

import { renderCollapsibleSectionHeader } from './collapsible-section-header.js';

/** Every panel header is this tall, open or closed, so a toggle never moves what is above it. */
export const COLLAPSIBLE_PANEL_HEADER_HEIGHT = '44px';

const choices = new Map<string, boolean>();

function preferenceKey(panelId: string): string {
  return `cc:panel-open:${panelId}`;
}

/**
 * The viewer's open or closed choice for a panel, by panel id. It is a local display
 * preference, not run data: the same panel opens the same way on every run.
 */
export function collapsiblePanelOpen(panelId: string, defaultOpen: boolean): boolean {
  const remembered = choices.get(panelId);
  if (remembered !== undefined) return remembered;
  const stored = safeLsGet(preferenceKey(panelId));
  return stored === '1' ? true : stored === '0' ? false : defaultOpen;
}

export function rememberCollapsiblePanel(panelId: string, open: boolean): void {
  // The toggle still works when storage is blocked; only the reload memory is lost.
  choices.set(panelId, open);
  safeLsSet(preferenceKey(panelId), open ? '1' : '0');
}

export function toggleCollapsiblePanel(panelId: string, defaultOpen: boolean): boolean {
  const open = !collapsiblePanelOpen(panelId, defaultOpen);
  rememberCollapsiblePanel(panelId, open);
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
  return html`<section
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
