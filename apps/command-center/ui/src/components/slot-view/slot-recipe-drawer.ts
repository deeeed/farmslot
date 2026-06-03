import { html, nothing, type TemplateResult } from 'lit';

export function renderSlotRecipeDrawer(args: {
  reviewPanelOpen: boolean;
  reviewFullWidth: boolean;
  reviewPanelWidth: number;
  resizing: string | null;
  drawerLabel: string;
  collapsedTitle: string;
  headerContent?: TemplateResult;
  recipeExecutionOverlay: TemplateResult | typeof nothing;
  bodyContent: TemplateResult;
  onResizeStart: (event: MouseEvent) => void;
  onToggleFullWidth: () => void;
  onClose: () => void;
  onOpen: () => void;
}): TemplateResult {
  return args.reviewPanelOpen
    ? html`
        ${!args.reviewFullWidth
          ? html`<div
              class="sv-resize-h ${args.resizing === 'review' ? 'active' : ''}"
              @mousedown=${args.onResizeStart}
            ></div>`
          : nothing}
        <div
          class="sv-review-col"
          style="${args.reviewFullWidth ? 'flex:1' : `width:${args.reviewPanelWidth}px`}"
        >
          <div class="sv-review-header">
            <span>${args.drawerLabel}</span>
            ${args.headerContent ?? nothing}
            <button
              class="sv-task-panel-close"
              title="${args.reviewFullWidth ? 'Restore' : 'Maximize'}"
              @click=${args.onToggleFullWidth}
            >
              ${args.reviewFullWidth ? '\u22A1' : '\u2922'}
            </button>
            <button class="sv-task-panel-close" @click=${args.onClose}>&times;</button>
          </div>
          <div class="sv-review-body">${args.bodyContent}</div>
        </div>
        ${args.recipeExecutionOverlay}
      `
    : html`
        <div
          class="sv-stream-collapsed sv-review-collapsed"
          @click=${args.onOpen}
          title=${args.collapsedTitle}
        >
          <span class="sv-stream-collapsed-label">${args.drawerLabel}</span>
        </div>
      `;
}
