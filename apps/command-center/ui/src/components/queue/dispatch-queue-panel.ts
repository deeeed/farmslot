import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  BacklogItem,
  DispatchQueueReorderResult,
  DispatchQueueUpdateResult,
  QueueItem,
  SlotStatus,
  WorkGraphProjection,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, subscribe } from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import {
  isOrphanedBacklogQueueItemForUi,
  queueRemoveRequestForUi,
} from './dispatch-queue-panel-model.js';

function labelFor(item: QueueItem): string {
  return (
    item.label?.trim() ||
    item.evalCell?.candidateLabel?.trim() ||
    `${item.flowType} ${item.ticketOrPr}`
  );
}

function slotsText(item: QueueItem): string {
  const slots = item.allowedSlots ?? [];
  if (slots.length === 0) return 'Any eligible slot';
  if (slots.length === 1) return `1 slot: ${slots[0]}`;
  return `${slots.length} slots`;
}

function kindLabel(item: QueueItem): string {
  return item.queueKind === 'eval-cell' ? 'eval' : item.flowType;
}

function isSlotReady(slot: SlotStatus): boolean {
  return (
    slot.enabled !== false &&
    slot.dispatchable !== false &&
    slot.agent !== 'working' &&
    slot.lifecycle === 'ready'
  );
}

function graphContext(
  item: QueueItem,
  backlogItems: BacklogItem[],
  workGraphs: WorkGraphProjection[],
): string {
  const backlog = item.backlogItemId
    ? backlogItems.find((candidate) => candidate.id === item.backlogItemId)
    : undefined;
  const graph = item.workGraphId
    ? workGraphs.find((candidate) => candidate.graph.id === item.workGraphId)
    : undefined;
  const parts = [
    graph ? `graph:${graph.graph.title}` : item.workGraphId ? `graph:${item.workGraphId}` : '',
    item.workNodeId ? `node:${item.workNodeId}` : '',
    backlog?.title ? `spec:${backlog.title}` : '',
    item.runner || item.model || item.effort
      ? `exec:${[item.runner, item.model, item.effort].filter(Boolean).join('/')}`
      : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

@customElement('dispatch-queue-panel')
export class DispatchQueuePanel extends LitElement {
  @property({ attribute: false }) items: QueueItem[] = [];
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ type: Boolean }) readonly = false;
  @property({ attribute: 'panel-title' }) panelTitle = 'Queue';

  @state() private _dragId = '';
  @state() private _busyItem = '';
  @state() private _error = '';
  @state() private _pickerItemId = '';
  @state() private _slots: SlotStatus[] = [];
  @state() private _backlogItems: BacklogItem[] = [];
  @state() private _workGraphs: WorkGraphProjection[] = [];
  private _unsub?: () => void;

  static styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .queue-shell {
      border: 1px solid ${unsafeCSS(colors.textMuted)}22;
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      padding: ${unsafeCSS(spacing.md)};
    }
    .queue-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.sm)};
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }
    .title {
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 700;
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .count {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .empty,
    .error {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      padding: ${unsafeCSS(spacing.sm)} 0;
    }
    .error {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .rows {
      display: grid;
      gap: 6px;
    }
    .row {
      display: grid;
      grid-template-columns: 32px minmax(170px, 1fr) 78px minmax(120px, 180px) 58px 42px;
      align-items: center;
      gap: 8px;
      border: 1px solid ${unsafeCSS(colors.textMuted)}22;
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgSurface)};
      padding: 8px;
    }
    :host([compact]) .row {
      grid-template-columns: 28px minmax(130px, 1fr) 58px 58px 42px;
    }
    .row.dragging {
      border-color: ${unsafeCSS(colors.accent)};
      opacity: 0.7;
    }
    .handle {
      color: ${unsafeCSS(colors.textMuted)};
      cursor: grab;
      user-select: none;
      text-align: center;
      font-size: 16px;
    }
    .main {
      min-width: 0;
      display: grid;
      gap: 3px;
    }
    .label {
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta.graph {
      color: ${unsafeCSS(colors.accent)};
    }
    .meta.warn {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .kind {
      color: ${unsafeCSS(colors.accent)};
      border: 1px solid ${unsafeCSS(colors.accent)}55;
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 3px 6px;
      font-size: 10px;
      text-align: center;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid ${unsafeCSS(colors.textMuted)}33;
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgBase)};
      color: ${unsafeCSS(colors.textPrimary)};
      padding: 5px 6px;
      font: inherit;
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .priority {
      max-width: 58px;
    }
    .slot-control {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      min-width: 0;
    }
    .slot-summary {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .picker {
      grid-column: 2 / -1;
      display: grid;
      gap: 8px;
      border: 1px solid ${unsafeCSS(colors.accent)}33;
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgBase)};
      padding: 8px;
    }
    .picker-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .slot-list {
      display: grid;
      gap: 4px;
      max-height: 220px;
      overflow: auto;
    }
    .slot-choice {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      border: 1px solid ${unsafeCSS(colors.textMuted)}22;
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 7px 8px;
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      text-transform: none;
      letter-spacing: 0;
    }
    .slot-choice.disabled {
      opacity: 0.55;
    }
    .slot-choice input {
      width: auto;
      margin-top: 2px;
    }
    .slot-name {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .slot-meta {
      color: ${unsafeCSS(colors.textMuted)};
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
    }
    button {
      border: 1px solid ${unsafeCSS(colors.textMuted)}33;
      border-radius: ${unsafeCSS(radii.sm)};
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      padding: 5px 7px;
      font: inherit;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
    }
    button:hover {
      color: ${unsafeCSS(colors.textPrimary)};
      border-color: ${unsafeCSS(colors.textMuted)}66;
    }
    button:disabled,
    input:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    @media (max-width: 760px) {
      .row {
        grid-template-columns: 28px minmax(0, 1fr) 58px minmax(90px, 120px) 58px 42px;
      }
      :host([compact]) .row {
        grid-template-columns: 28px minmax(0, 1fr) 58px 58px 42px;
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this._syncState(getState());
    this._unsub = subscribe((state) => this._syncState(state));
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = undefined;
  }

  private _syncState(state: AppState): void {
    this._slots = state.fleet?.slots ?? [];
    this._backlogItems = state.backlogItems;
    this._workGraphs = state.workGraphs;
  }

  private _isOrphan(item: QueueItem): boolean {
    return isOrphanedBacklogQueueItemForUi(item, this._backlogItems);
  }

  private async _remove(item: QueueItem): Promise<void> {
    this._busyItem = item.id;
    this._error = '';
    try {
      const request = queueRemoveRequestForUi(item, this._backlogItems);
      await gateway.request(request.method, request.params);
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error);
    } finally {
      this._busyItem = '';
    }
  }

  private async _update(
    item: QueueItem,
    patch: { priority?: number; allowedSlots?: string[] | null },
  ): Promise<void> {
    this._busyItem = item.id;
    this._error = '';
    try {
      await gateway.request<DispatchQueueUpdateResult>(Methods.DISPATCH_QUEUE_UPDATE, {
        itemId: item.id,
        ...patch,
      });
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error);
    } finally {
      this._busyItem = '';
    }
  }

  private _slotOptions(item: QueueItem): SlotStatus[] {
    const preferred = (slot: SlotStatus) => (slot.project === item.project ? 0 : 1);
    return [...this._slots].sort(
      (a, b) =>
        preferred(a) - preferred(b) ||
        a.machine.localeCompare(b.machine) ||
        a.slot.localeCompare(b.slot),
    );
  }

  private _slotDisabled(slot: SlotStatus, item: QueueItem): boolean {
    return slot.project !== item.project || slot.enabled === false || slot.dispatchable === false;
  }

  private _slotDisabledReason(slot: SlotStatus, item: QueueItem): string {
    if (slot.project !== item.project)
      return `project ${slot.project || 'unknown'} does not match ${item.project}`;
    if (slot.enabled === false) return 'slot disabled';
    if (slot.dispatchable === false) return 'slot not dispatchable';
    return '';
  }

  private _slotAgentLabel(slot: SlotStatus): string {
    if (slot.agent === 'working') return 'busy';
    if (slot.agent === 'idle') return 'available';
    return slot.agent || 'available';
  }

  private _slotMeta(slot: SlotStatus, item: QueueItem): string {
    const reasons = [
      slot.lifecycle,
      this._slotAgentLabel(slot),
      slot.branch || 'no branch',
      this._slotDisabledReason(slot, item),
    ].filter(Boolean);
    return reasons.join(' · ');
  }

  private _slotChecked(item: QueueItem, slotId: string): boolean {
    return (item.allowedSlots ?? []).includes(slotId);
  }

  private async _toggleSlot(item: QueueItem, slotId: string, checked: boolean): Promise<void> {
    const current = item.allowedSlots ?? [];
    const next = checked
      ? [...new Set([...current, slotId])]
      : current.filter((candidate) => candidate !== slotId);
    await this._update(item, { allowedSlots: next.length ? next : null });
  }

  private _renderSlotControl(item: QueueItem) {
    if (this.compact) return nothing;
    const open = this._pickerItemId === item.id;
    return html`
      <div class="slot-control">
        <span class="slot-summary" title=${slotsText(item)}>${slotsText(item)}</span>
        <button
          title="Choose allowed slots"
          ?disabled=${this.readonly || this._busyItem === item.id}
          @click=${() => {
            this._pickerItemId = open ? '' : item.id;
          }}
        >
          ${open ? 'Close' : 'Change'}
        </button>
      </div>
    `;
  }

  private _renderSlotPickerDetails(item: QueueItem) {
    if (this.compact || this._pickerItemId !== item.id) return nothing;
    const options = this._slotOptions(item);
    return html`
      <div class="picker">
        <div class="picker-actions">
          <button
            ?disabled=${this.readonly || this._busyItem === item.id}
            @click=${() => this._update(item, { allowedSlots: null })}
          >
            Any eligible slot
          </button>
          ${item.slotId
            ? html`
                <button
                  ?disabled=${this.readonly || this._busyItem === item.id}
                  @click=${() => this._update(item, { allowedSlots: [item.slotId!] })}
                >
                  Only ${item.slotId}
                </button>
              `
            : nothing}
        </div>
        <div class="slot-list">
          ${options.length === 0
            ? html`<div class="empty">No fleet slots loaded yet</div>`
            : options.map((slot) => {
                const disabled = this._slotDisabled(slot, item);
                return html`
                  <label class="slot-choice ${disabled ? 'disabled' : ''}">
                    <input
                      type="checkbox"
                      .checked=${this._slotChecked(item, slot.slot)}
                      ?disabled=${this.readonly || this._busyItem === item.id || disabled}
                      @change=${(event: Event) =>
                        this._toggleSlot(
                          item,
                          slot.slot,
                          (event.target as HTMLInputElement).checked,
                        )}
                    />
                    <span>
                      <span class="slot-name">${slot.slot}</span>
                      <span class="slot-meta">${this._slotMeta(slot, item)}</span>
                    </span>
                  </label>
                `;
              })}
        </div>
      </div>
    `;
  }

  private _queueBlocker(item: QueueItem): string {
    const candidates = this._slots.filter((slot) => {
      if (slot.project !== item.project) return false;
      if (item.slotId) return slot.slot === item.slotId;
      if (item.allowedSlots?.length) return item.allowedSlots.includes(slot.slot);
      return true;
    });
    if (candidates.length === 0) return 'waiting for visible allowed slot(s)';
    if (candidates.some((slot) => isSlotReady(slot))) return '';
    return 'waiting for allowed slot(s)';
  }

  private async _reorder(targetId: string): Promise<void> {
    if (!this._dragId || this._dragId === targetId) return;
    const next = [...this.items];
    const from = next.findIndex((item) => item.id === this._dragId);
    const to = next.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this._error = '';
    try {
      await gateway.request<DispatchQueueReorderResult>(Methods.DISPATCH_QUEUE_REORDER, {
        itemIds: next.map((item) => item.id),
      });
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error);
    } finally {
      this._dragId = '';
    }
  }

  render() {
    const rows = [...this.items].sort(
      (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
    );
    return html`
      <section class="queue-shell">
        <div class="queue-head">
          <span class="title">${this.panelTitle}</span>
          <span class="count">${rows.length} upcoming</span>
        </div>
        ${this._error ? html`<div class="error">${this._error}</div>` : nothing}
        ${rows.length === 0
          ? html`<div class="empty">No queued work</div>`
          : html`
              <div class="rows">
                ${rows.map(
                  (item) => html`
                    <div
                      class="row ${this._dragId === item.id ? 'dragging' : ''}"
                      .draggable=${!this.readonly}
                      @dragstart=${() => {
                        this._dragId = item.id;
                      }}
                      @dragend=${() => {
                        this._dragId = '';
                      }}
                      @dragover=${(event: DragEvent) => event.preventDefault()}
                      @drop=${(event: DragEvent) => {
                        event.preventDefault();
                        this._reorder(item.id);
                      }}
                    >
                      <span class="handle" title="Drag to reorder">≡</span>
                      <div class="main">
                        <span class="label">${labelFor(item)}</span>
                        <span class="meta"
                          >${item.project} ·
                          ${item.ticketOrPr}${item.prepareProfile
                            ? ` · prep:${item.prepareProfile}`
                            : ''}${item.evalCell?.capGroupId
                            ? ` · ${item.evalCell.capGroupId}`
                            : ''}</span
                        >
                        ${graphContext(item, this._backlogItems, this._workGraphs)
                          ? html`<span class="meta graph"
                              >${graphContext(item, this._backlogItems, this._workGraphs)}</span
                            >`
                          : nothing}
                        ${this._isOrphan(item)
                          ? html`<span class="meta warn"
                              >orphaned backlog link — remove to discard stale queue row</span
                            >`
                          : nothing}
                        ${this._queueBlocker(item)
                          ? html`<span class="meta warn">${this._queueBlocker(item)}</span>`
                          : nothing}
                      </div>
                      <span class="kind">${kindLabel(item)}</span>
                      ${this._renderSlotControl(item)}
                      <input
                        class="priority"
                        type="number"
                        min="1"
                        .value=${String(item.priority)}
                        ?disabled=${this.readonly || this._busyItem === item.id}
                        @change=${(event: Event) =>
                          this._update(item, {
                            priority: Number((event.target as HTMLInputElement).value),
                          })}
                      />
                      <button
                        title="Remove from queue"
                        ?disabled=${this.readonly || this._busyItem === item.id}
                        @click=${() => this._remove(item)}
                      >
                        x
                      </button>
                      ${this._renderSlotPickerDetails(item)}
                    </div>
                  `,
                )}
              </div>
            `}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dispatch-queue-panel': DispatchQueuePanel;
  }
}
