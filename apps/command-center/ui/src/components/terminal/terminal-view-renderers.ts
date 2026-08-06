import { html } from 'lit';

import { Methods } from '@farmslot/protocol';

import { isSlotPinned, togglePinnedSlot } from '../../utils/pinned-slots.js';

import {
  terminalAttachOverlay,
  type TerminalAttachPhase,
  terminalShowsLiveBadge,
} from './terminal-view-attach-model.js';

export type TerminalMode = 'pty' | 'poll' | 'none';

export interface TmuxWindowSummary {
  index: number;
  name: string;
  active: boolean;
  panes: Array<{ index: number; active: boolean }>;
}

export function renderRunnerBadge(runner: string, model: string, agent: string) {
  if (!runner) return '';
  const idle = !agent || agent === 'idle';
  const title = `runner=${runner}${model ? ` model=${model}` : ''}${idle ? ' (last known — not running)' : ''}`;
  return html`<span class="runner-badge ${idle ? 'dim' : ''}" title=${title}>
    ${runner}${model ? html`<span class="runner-model">·${model}</span>` : ''}
  </span>`;
}

export function renderTerminalModeBadge(mode: TerminalMode, attachPhase: TerminalAttachPhase) {
  if (terminalShowsLiveBadge(mode, attachPhase)) {
    return html`<span class="badge mode-pty">LIVE</span>`;
  }
  if (mode === 'poll' && attachPhase === 'live') {
    return html`<span class="badge mode-poll">OBSERVE</span>`;
  }
  if (mode === 'pty' && attachPhase !== 'idle') {
    return html`<span class="badge mode-connecting">ATTACH</span>`;
  }
  return '';
}

export interface TmuxToolbarContext {
  isWorkerTarget: boolean;
  mode: TerminalMode;
  selectMode: boolean;
  windows: TmuxWindowSummary[];
  renaming: boolean;
  renameValue: string;
  setRenameValue: (value: string) => void;
  startRename: () => void;
  submitRename: () => void | Promise<void>;
  cancelRename: () => void;
  toggleSelectMode: () => void;
  sendRawKeys: (data: string) => void;
  tmuxAction: (method: string, params?: Record<string, unknown>) => void | Promise<void>;
}

export function renderTmuxToolbar(ctx: TmuxToolbarContext) {
  if (ctx.isWorkerTarget) return '';
  if (ctx.mode !== 'pty') return '';

  return html`
    <div class="tmux-toolbar">
      <span class="tmux-label">Pane</span>
      <div class="tmux-group">
        <button
          class="tmux-btn"
          title="Split horizontally"
          @click=${() => ctx.tmuxAction(Methods.TMUX_SPLIT, { direction: 'h' })}
        >
          ${'\u2502'}
        </button>
        <button
          class="tmux-btn"
          title="Split vertically"
          @click=${() => ctx.tmuxAction(Methods.TMUX_SPLIT, { direction: 'v' })}
        >
          ${'\u2500'}
        </button>
      </div>
      <div class="tmux-group">
        <button
          class="tmux-btn"
          title="Pane up"
          @click=${() => ctx.tmuxAction(Methods.TMUX_SELECT_PANE, { direction: 'U' })}
        >
          ${'\u2191'}
        </button>
        <button
          class="tmux-btn"
          title="Pane down"
          @click=${() => ctx.tmuxAction(Methods.TMUX_SELECT_PANE, { direction: 'D' })}
        >
          ${'\u2193'}
        </button>
        <button
          class="tmux-btn"
          title="Pane left"
          @click=${() => ctx.tmuxAction(Methods.TMUX_SELECT_PANE, { direction: 'L' })}
        >
          ${'\u2190'}
        </button>
        <button
          class="tmux-btn"
          title="Pane right"
          @click=${() => ctx.tmuxAction(Methods.TMUX_SELECT_PANE, { direction: 'R' })}
        >
          ${'\u2192'}
        </button>
      </div>
      <button
        class="tmux-btn"
        title="Zoom pane (toggle fullscreen)"
        @click=${() => ctx.tmuxAction(Methods.TMUX_ZOOM_PANE)}
      >
        ${'\u2922'}
      </button>
      <button
        class="tmux-btn danger"
        title="Kill pane"
        @click=${() => ctx.tmuxAction(Methods.TMUX_KILL_PANE)}
      >
        ${'\u2717'}
      </button>

      <div class="tmux-sep"></div>

      <button
        class="tmux-btn"
        title="Send Ctrl+B (tmux prefix)"
        @click=${() => ctx.sendRawKeys('\x02')}
      >
        ^B
      </button>
      <button
        class="tmux-btn ${ctx.selectMode ? 'active' : ''}"
        title="${ctx.selectMode
          ? 'Click to return to mouse mode'
          : 'Click to enable text selection (disables tmux mouse)'}"
        @click=${ctx.toggleSelectMode}
      >
        ${ctx.selectMode ? 'Select' : 'Mouse'}
      </button>

      <div class="tmux-sep"></div>

      <span class="tmux-label">Win</span>
      <button
        class="tmux-btn"
        title="New window"
        @click=${() => ctx.tmuxAction(Methods.TMUX_NEW_WINDOW)}
      >
        +
      </button>
      <button class="tmux-btn" title="Rename window" @click=${ctx.startRename}>Rename</button>

      <div class="tmux-sep"></div>

      <span class="tmux-label">Claude</span>
      <div class="tmux-group">
        <button
          class="tmux-btn warn"
          title="Shift+Tab (cycle mode)"
          @click=${() => ctx.sendRawKeys('\x1b[Z')}
        >
          Mode
        </button>
        <button class="tmux-btn" title="Escape (interrupt)" @click=${() => ctx.sendRawKeys('\x1b')}>
          Esc
        </button>
        <button class="tmux-btn" title="Ctrl+C (cancel)" @click=${() => ctx.sendRawKeys('\x03')}>
          ^C
        </button>
      </div>

      ${ctx.windows.length > 0
        ? html`
            <div class="tmux-windows">
              ${ctx.windows.map(
                (window) => html`
                  <button
                    class="tmux-win-btn ${window.active ? 'active' : ''}"
                    title="Window ${window.index}: ${window.name}${window.panes.length > 1
                      ? ` (${window.panes.length} panes)`
                      : ''}"
                    @click=${() =>
                      ctx.tmuxAction(Methods.TMUX_SELECT_WINDOW, { index: window.index })}
                  >
                    ${window.index}:${window.name}
                  </button>
                `,
              )}
            </div>
          `
        : ''}
      ${ctx.renaming
        ? html`
            <div class="tmux-rename-bar">
              <input
                class="tmux-rename-input"
                type="text"
                placeholder="Window name..."
                .value=${ctx.renameValue}
                @input=${(event: InputEvent) => {
                  ctx.setRenameValue((event.target as HTMLInputElement).value);
                }}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === 'Enter') ctx.submitRename();
                  if (event.key === 'Escape') ctx.cancelRename();
                }}
              />
              <button class="tmux-btn active" @click=${ctx.submitRename}>OK</button>
              <button class="tmux-btn" @click=${ctx.cancelRename}>Cancel</button>
            </div>
          `
        : ''}
    </div>
  `;
}

export interface TerminalChromeContext {
  showInputBar: boolean;
  isWorkerTarget: boolean;
  lifecycle: string;
  mode: TerminalMode;
  attachPhase: TerminalAttachPhase;
  agent: string;
  runner: string;
  model: string;
  summary: string;
  slotId: string;
  targetLabel: string;
  hasTarget: boolean;
  taskMarkdown: string;
  toolbar: unknown;
  reconnecting: boolean;
  recoveryMessage: string;
  copyToast: boolean;
  exited: boolean;
  inputText: string;
  setInputText: (value: string) => void;
  onHeaderClick: () => void;
  onCloseClick: (event: Event) => void;
  onReconnect: () => void | Promise<void>;
  onInputKeydown: (event: KeyboardEvent) => void;
  onSend: () => void;
  dropOverlay: unknown;
  attachmentTray: unknown;
  onDragEnter: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

export function renderTerminalChrome(ctx: TerminalChromeContext) {
  return html`
    <div class="header" @click=${ctx.onHeaderClick}>
      <span class="slot-id">${ctx.targetLabel}</span>
      ${ctx.isWorkerTarget ? html`<span class="badge mode-pty">worker</span>` : ''}
      ${!ctx.isWorkerTarget && ctx.lifecycle
        ? html` <span class="badge ${ctx.lifecycle}">${ctx.lifecycle}</span> `
        : ''}
      ${renderRunnerBadge(ctx.runner, ctx.model, ctx.agent)}
      ${renderTerminalModeBadge(ctx.mode, ctx.attachPhase)}
      ${ctx.agent && ctx.agent !== ctx.lifecycle
        ? html`<span class="agent-state">${ctx.agent}</span>`
        : ''}
      ${ctx.summary ? html`<span class="task-summary">${ctx.summary}</span>` : ''}
      <span style="flex:1"></span>
      ${!ctx.isWorkerTarget && ctx.slotId
        ? html`
            <button
              class="slot-link"
              type="button"
              @click=${(event: Event) => {
                event.stopPropagation();
                togglePinnedSlot(ctx.slotId);
              }}
              title=${isSlotPinned(ctx.slotId)
                ? 'Remove this slot from pinned slots'
                : 'Add this slot to pinned slots'}
            >
              ${isSlotPinned(ctx.slotId) ? 'unpin' : '+pin'}
            </button>
            <a
              class="slot-link"
              href="#slot/${ctx.slotId}"
              @click=${(event: Event) => event.stopPropagation()}
              title="Open slot view"
              >&#x2197;</a
            >
          `
        : ''}
      ${ctx.hasTarget
        ? html`<button
            class="slot-link close"
            type="button"
            @click=${ctx.onCloseClick}
            title="Close terminal view"
          >
            ×
          </button>`
        : ''}
    </div>
    ${ctx.taskMarkdown
      ? html`
          <div class="progress-strip">
            <progress-tracker .markdown=${ctx.taskMarkdown} compact></progress-tracker>
          </div>
        `
      : ''}
    ${ctx.toolbar}
    <div
      class="terminal-wrap"
      @dragenter=${ctx.onDragEnter}
      @dragover=${ctx.onDragOver}
      @dragleave=${ctx.onDragLeave}
      @drop=${ctx.onDrop}
    >
      ${(() => {
        const overlay = terminalAttachOverlay({
          hasTarget: ctx.hasTarget,
          attachPhase: ctx.attachPhase,
          reconnecting: ctx.reconnecting,
          recoveryMessage: ctx.recoveryMessage,
          mode: ctx.mode,
        });
        return overlay.show
          ? html`
              <div class="loading-overlay">
                <div class="spinner">
                  <span class="spinner-dots">...</span>
                  <span class="spinner-text">${overlay.message}</span>
                </div>
              </div>
            `
          : '';
      })()}
      <div class="terminal-container"></div>
      ${ctx.copyToast ? html`<div class="copy-toast">Copied</div>` : ''} ${ctx.dropOverlay}
    </div>
    ${ctx.attachmentTray}
    ${ctx.exited
      ? html`
          <div class="exit-bar">
            <span class="exit-msg">Session ended</span>
            <button class="reconnect-btn" ?disabled=${ctx.reconnecting} @click=${ctx.onReconnect}>
              ${ctx.reconnecting ? 'Reconnecting...' : 'Reconnect'}
            </button>
          </div>
        `
      : ''}
    ${ctx.showInputBar
      ? html`
          <div class="input-bar">
            <input
              class="input-field"
              type="text"
              placeholder="Send to terminal..."
              .value=${ctx.inputText}
              @input=${(event: InputEvent) =>
                ctx.setInputText((event.target as HTMLInputElement).value)}
              @keydown=${ctx.onInputKeydown}
            />
            <button class="send-btn" @click=${ctx.onSend}>Send</button>
          </div>
        `
      : ''}
  `;
}
