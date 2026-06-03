import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ChatSessionSummary } from '@farmslot/protocol';

import { colors, fonts, radii, shadows, spacing } from '../../styles/theme-tokens.js';

// run/family/slot scopes are kept for sessions persisted before the
// single-global-session migration (commit 7ad8a80). New chats are only ever
// global or manual; the legacy labels survive so history rows for older
// scoped sessions still render with a sensible badge.
const SCOPE_LABELS: Record<ChatSessionSummary['scope'], string> = {
  global: 'Global',
  run: 'Run',
  family: 'Family',
  slot: 'Slot',
  manual: 'Manual',
  unknown: 'Other',
};

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const delta = Date.now() - ms;
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < day * 30) return `${Math.floor(delta / day)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

@customElement('chat-history-modal')
export class ChatHistoryModal extends LitElement {
  @property({ attribute: false }) sessions: ChatSessionSummary[] = [];
  @property({ type: String }) activeSessionId = 'global';

  @state() private query = '';
  @state() private selected = new Set<string>();

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onWindowKeydown);
    void this.updateComplete.then(() => {
      const search = this.querySelector<HTMLInputElement>('.chm-search');
      search?.focus();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onWindowKeydown);
  }

  private readonly onWindowKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close();
    }
  };

  protected override willUpdate(changed: Map<string, unknown>) {
    // Drop selected ids that no longer exist in the latest sessions list so a
    // gateway-side delete can't leave a stale id selected (which would
    // re-delete on the next bulk action). Only mutate when something actually
    // changed to avoid an extra render.
    if (changed.has('sessions') && this.selected.size > 0) {
      const ids = new Set(this.sessions.map((s) => s.id));
      const next = new Set<string>();
      for (const id of this.selected) if (ids.has(id)) next.add(id);
      if (next.size !== this.selected.size) this.selected = next;
    }
  }

  private close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) this.close();
  }

  private select(id: string) {
    this.dispatchEvent(
      new CustomEvent('select', { detail: { sessionId: id }, bubbles: true, composed: true }),
    );
  }

  private deleteIds(ids: string[]) {
    if (!ids.length) return;
    this.dispatchEvent(
      new CustomEvent('delete', { detail: { sessionIds: ids }, bubbles: true, composed: true }),
    );
    this.selected = new Set();
  }

  private pinId(id: string) {
    this.dispatchEvent(
      new CustomEvent('pin', { detail: { sessionId: id }, bubbles: true, composed: true }),
    );
  }

  private toggleRow(id: string, checked: boolean) {
    const next = new Set(this.selected);
    if (checked) next.add(id);
    else next.delete(id);
    this.selected = next;
  }

  private filtered(): ChatSessionSummary[] {
    const needle = this.query.trim().toLowerCase();
    if (!needle) return this.sessions;
    return this.sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        session.id.toLowerCase().includes(needle) ||
        (session.lastPreview ?? '').toLowerCase().includes(needle),
    );
  }

  private deleteEphemeral() {
    const before = this.sessions.filter((s) => s.pinned === false).map((s) => s.id);
    if (!before.length) return;
    // Operator footgun guard: ephemeral chats can hold 30+ minutes of work
    // that wasn't yet pinned. Make the bulk wipe a deliberate confirm.
    // FOLLOW-UP — issue #68: swap window.confirm() for a project-internal
    // confirm dialog so the bulk-delete flow becomes assertable and theme-
    // consistent. Native confirm is untestable via CDP/Playwright today.
    const ok = window.confirm(
      `Permanently delete ${before.length} ephemeral chat${before.length === 1 ? '' : 's'}? This cannot be undone.`,
    );
    if (!ok) return;
    // Re-filter against the latest snapshot at the moment of confirm so a
    // chat that became ephemeral while the dialog was open isn't wiped
    // (and one that was just pinned doesn't slip through). Intersect with
    // the pre-confirm list so we only touch ids the operator actually saw.
    const confirmed = new Set(before);
    const ids = this.sessions
      .filter((s) => s.pinned === false && confirmed.has(s.id))
      .map((s) => s.id);
    if (!ids.length) return;
    this.deleteIds(ids);
  }

  override render() {
    const visible = this.filtered();
    const ephemeralCount = this.sessions.filter((s) => s.pinned === false).length;
    return html`
      <style>
        chat-history-modal .chm-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          z-index: 1100;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        chat-history-modal .chm-modal {
          width: min(720px, 92vw);
          max-height: 80vh;
          background: ${colors.bgSurface};
          border: 1px solid ${colors.bgCard};
          border-radius: ${radii.md};
          box-shadow: ${shadows.elevated};
          display: flex;
          flex-direction: column;
          font-family: ${fonts.mono};
          color: ${colors.textPrimary};
        }
        chat-history-modal .chm-header {
          display: flex;
          align-items: center;
          gap: ${spacing.md};
          padding: ${spacing.md} ${spacing.xl};
          border-bottom: 1px solid ${colors.bgCard};
        }
        chat-history-modal .chm-title {
          flex: 1;
          font-weight: 700;
          color: ${colors.textAccent};
        }
        chat-history-modal .chm-close {
          background: transparent;
          border: none;
          color: ${colors.textMuted};
          font-size: ${fonts.sizeLg};
          cursor: pointer;
          padding: 2px 4px;
        }
        chat-history-modal .chm-close:hover {
          color: ${colors.textPrimary};
        }
        chat-history-modal .chm-toolbar {
          display: flex;
          gap: ${spacing.sm};
          align-items: center;
          padding: ${spacing.sm} ${spacing.xl};
          border-bottom: 1px solid ${colors.bgCard};
        }
        chat-history-modal .chm-search {
          flex: 1;
          background: ${colors.bgInput};
          color: ${colors.textPrimary};
          border: 1px solid ${colors.bgCard};
          border-radius: ${radii.sm};
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeSm};
          padding: 6px 10px;
          outline: none;
        }
        chat-history-modal .chm-search:focus {
          border-color: ${colors.accent}66;
        }
        chat-history-modal .chm-btn {
          background: transparent;
          border: 1px solid ${colors.textMuted}44;
          color: ${colors.textSecondary};
          border-radius: ${radii.sm};
          padding: 4px 10px;
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeXs};
          cursor: pointer;
          flex-shrink: 0;
        }
        chat-history-modal .chm-btn:hover:not(:disabled) {
          color: ${colors.textPrimary};
        }
        chat-history-modal .chm-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        chat-history-modal .chm-btn.danger {
          color: ${colors.statusFail};
          border-color: ${colors.statusFail}55;
        }
        chat-history-modal .chm-btn.danger:hover:not(:disabled) {
          background: ${colors.statusFail}15;
        }
        chat-history-modal .chm-list {
          flex: 1;
          overflow-y: auto;
          padding: ${spacing.sm} 0;
        }
        chat-history-modal .chm-row {
          display: grid;
          grid-template-columns: 24px 1fr auto auto auto;
          gap: ${spacing.md};
          align-items: center;
          padding: ${spacing.sm} ${spacing.xl};
          border-bottom: 1px solid ${colors.bgCard};
          cursor: pointer;
        }
        chat-history-modal .chm-row:hover {
          background: ${colors.bgCard};
        }
        chat-history-modal .chm-row.active {
          background: ${colors.accent}15;
        }
        chat-history-modal .chm-row-title {
          font-size: ${fonts.sizeSm};
          color: ${colors.textPrimary};
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }
        chat-history-modal .chm-row-meta {
          color: ${colors.textMuted};
          font-size: 10px;
          margin-top: 2px;
        }
        chat-history-modal .chm-badge {
          color: ${colors.textMuted};
          font-size: 10px;
          text-transform: uppercase;
          border: 1px solid ${colors.textMuted}44;
          border-radius: ${radii.sm};
          padding: 1px 6px;
          flex-shrink: 0;
        }
        chat-history-modal .chm-badge.ephemeral {
          color: ${colors.statusWarn};
          border-color: ${colors.statusWarn}66;
        }
        chat-history-modal .chm-empty {
          color: ${colors.textMuted};
          padding: ${spacing.xxl} ${spacing.xl};
          text-align: center;
          font-size: ${fonts.sizeSm};
        }
        chat-history-modal .chm-row-actions {
          display: flex;
          gap: ${spacing.xs};
          flex-shrink: 0;
        }
        chat-history-modal .chm-icon-btn {
          background: transparent;
          border: 1px solid ${colors.textMuted}33;
          border-radius: ${radii.sm};
          color: ${colors.textMuted};
          font-family: ${fonts.mono};
          font-size: 11px;
          padding: 2px 8px;
          cursor: pointer;
        }
        chat-history-modal .chm-icon-btn:hover {
          color: ${colors.textPrimary};
        }
        chat-history-modal .chm-icon-btn.danger:hover {
          color: ${colors.statusFail};
          border-color: ${colors.statusFail}66;
        }
        chat-history-modal .chm-footer {
          display: flex;
          align-items: center;
          gap: ${spacing.md};
          padding: ${spacing.sm} ${spacing.xl};
          border-top: 1px solid ${colors.bgCard};
          color: ${colors.textMuted};
          font-size: ${fonts.sizeXs};
        }
        chat-history-modal .chm-footer-spacer {
          flex: 1;
        }
      </style>
      <div class="chm-backdrop" @click=${this.onBackdrop}>
        <div class="chm-modal" role="dialog" aria-modal="true" aria-label="Chat history">
          <div class="chm-header">
            <span class="chm-title">Chat history</span>
            <button class="chm-close" title="Close" @click=${this.close}>×</button>
          </div>
          <div class="chm-toolbar">
            <input
              class="chm-search"
              type="search"
              placeholder="Search title, preview, or id…"
              .value=${this.query}
              @input=${(e: InputEvent) => {
                if (e.target instanceof HTMLInputElement) this.query = e.target.value;
              }}
            />
            <button
              class="chm-btn danger"
              ?disabled=${ephemeralCount === 0}
              title="Delete every chat that was never explicitly saved"
              @click=${this.deleteEphemeral}
            >
              Delete ephemeral (${ephemeralCount})
            </button>
          </div>
          <div class="chm-list">
            ${visible.length === 0
              ? html`<div class="chm-empty">
                  No saved chats. Manual chats are ephemeral until you Save them.
                </div>`
              : visible.map((session) => {
                  const isActive = session.id === this.activeSessionId;
                  const ephemeral = session.pinned === false;
                  return html`
                    <div
                      class="chm-row ${isActive ? 'active' : ''}"
                      @click=${() => this.select(session.id)}
                    >
                      <input
                        type="checkbox"
                        .checked=${this.selected.has(session.id)}
                        @click=${(e: Event) => e.stopPropagation()}
                        @change=${(e: Event) => {
                          if (e.target instanceof HTMLInputElement)
                            this.toggleRow(session.id, e.target.checked);
                        }}
                      />
                      <div>
                        <div class="chm-row-title">${session.title}</div>
                        <div class="chm-row-meta">
                          ${session.messageCount} msg ·
                          ${relativeTime(session.updatedAt)}${session.lastPreview
                            ? ` · ${session.lastPreview}`
                            : ''}
                        </div>
                      </div>
                      <span class="chm-badge">${SCOPE_LABELS[session.scope] ?? session.scope}</span>
                      <span class="chm-badge ${ephemeral ? 'ephemeral' : ''}"
                        >${ephemeral ? 'Ephemeral' : 'Saved'}</span
                      >
                      <div class="chm-row-actions">
                        ${ephemeral
                          ? html`
                              <button
                                class="chm-icon-btn"
                                title="Save this chat — keeps it after refresh / restart"
                                @click=${(e: Event) => {
                                  e.stopPropagation();
                                  this.pinId(session.id);
                                }}
                              >
                                Save
                              </button>
                            `
                          : ''}
                        <button
                          class="chm-icon-btn danger"
                          title="Delete this chat"
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            this.deleteIds([session.id]);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  `;
                })}
          </div>
          <div class="chm-footer">
            <span>${this.selected.size} selected</span>
            <span class="chm-footer-spacer"></span>
            <button
              class="chm-btn danger"
              ?disabled=${this.selected.size === 0}
              @click=${() => this.deleteIds([...this.selected])}
            >
              Delete selected
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-history-modal': ChatHistoryModal;
  }
}
