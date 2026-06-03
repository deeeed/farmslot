import { customElement } from 'lit/decorators.js';

import type {
  SlotStatus,
  TaskProgressUpdatedPayload,
  TerminalData,
  TerminalExitedPayload,
  TerminalModePayload,
} from '@farmslot/protocol';
import { Events, Methods } from '@farmslot/protocol';

import '../progress-tracker/progress-tracker.js';

import { gateway } from '../../gateway-client.js';

import { isRetryableTerminalSubscribeError, isRoleWindowMissingError } from './terminal-errors.js';
import {
  extractOsc52Clipboard,
  terminalRoleExitDecision,
  terminalTargetChanged,
} from './terminal-view-model.js';
import {
  renderTerminalChrome,
  renderTmuxToolbar,
  type TerminalMode,
} from './terminal-view-renderers.js';
import { TerminalViewState } from './terminal-view-state.js';
import { syncTerminalRunnerAccent, terminalViewStyles } from './terminal-view-styles.js';
import { readTerminalRunSummary } from './terminal-view-summary.js';
import { createTerminalRuntime } from './terminal-view-xterm.js';

// Window where non-zero TERMINAL_EXITED immediately after subscribe means "role pane already gone":
// short enough to avoid later legitimate exits, long enough for observed tmux select-window failures.
const ROLE_PANE_FAST_FAIL_MS = 3000;
const TMUX_LIST_POLL_MS = 15000;
const TMUX_LIST_ERROR_BACKOFF_MS = 30000;

@customElement('terminal-view')
export class TerminalView extends TerminalViewState {
  static styles = terminalViewStyles;

  connectedCallback() {
    super.connectedCallback();
    this._connected = gateway.connectionState === 'connected';
    this._recoveryMessage = this._connected ? '' : 'Waiting for gateway';
    this._unsubConn = gateway.onConnectionChange((state) => this._handleGatewayConnection(state));
    this._log('connectedCallback');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._log('disconnectedCallback');
    this._dispose();
  }

  firstUpdated() {
    this._initTerminal();
    if (this._hasTarget()) {
      if (gateway.connectionState === 'connected') {
        this._log('firstUpdated → subscribe');
        void this._subscribe();
      } else {
        this._log('firstUpdated → waiting for connection');
        this._reconnecting = true;
        this._recoveryMessage = 'Waiting for gateway';
      }
    }
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('_runner')) {
      syncTerminalRunnerAccent(this, this._runner);
    }

    // Detect terminal detachment (e.g., after HMR re-render orphans xterm canvas)
    if (this._terminal && this._termContainer && !this._termContainer.querySelector('.xterm')) {
      this._log('terminal detached — re-initializing (HMR recovery)');
      this._dispose();
      this._initTerminal();
      if (this._hasTarget()) this._subscribe();
      return;
    }

    const targetChanged = terminalTargetChanged(changed, {
      slotId: this.slotId,
      runId: this.runId,
      role: this.role,
      contextId: this.contextId,
      workerRefJson: this.workerRefJson,
    });
    if (!targetChanged || !this._terminal) return;
    this._log(
      'updated → target changed',
      `target=${this._targetLabel()} run=${this.runId || '-'} role=${this.role || '-'} context=${this.contextId || '-'}`,
    );
    this._postmortem = false;
    this._lastSubscribeError = '';
    this._subscribeOkAt = 0;
    this._teardownStreams();
    this._terminal.clear();
    this._taskMarkdown = '';
    this._mode = 'none';
    this._exited = false;
    this._recoveryMessage = gateway.connectionState === 'connected' ? '' : 'Waiting for gateway';
    this._reconnecting = gateway.connectionState !== 'connected';
    if (gateway.connectionState === 'connected') {
      void this._subscribe();
    }
  }

  private _initTerminal() {
    const runtime = createTerminalRuntime(this._termContainer, () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this._sendResize(), 300);
    });
    this._terminal = runtime.terminal;
    this._fitAddon = runtime.fitAddon;
    this._resizeObserver = runtime.resizeObserver;
  }

  private _syncRunSummary() {
    const summary = readTerminalRunSummary({
      slotId: this.slotId,
      runId: this.runId,
      worker: this._workerRef(),
      currentTaskId: this._taskId,
    });
    if (!summary) return;
    if (summary.slot) {
      this._taskId = summary.slot.taskId;
      this._lifecycle = summary.slot.lifecycle;
      this._agent = summary.slot.agent;
      this._runner = summary.slot.runner;
      this._model = summary.slot.model;
    }
    this._summary = summary.summary;
  }

  private async _subscribe() {
    if (!this._hasTarget() || gateway.connectionState !== 'connected') return;
    const worker = this._workerRef();

    // Bump seq first so any in-flight request from a prior call short-circuits
    // when its response lands. Duplicate work is absorbed by the gateway's
    // pty-detach linger window — we don't need a UI-side guard, which has
    // historically wedged the terminal on "Connecting…" when a request hung.
    this._teardownStreams(false);
    const subscribeSeq = ++this._subscribeSeq;

    this._syncRunSummary();
    this._dataCount = 0;
    this._ptyReady = false;
    // Reset the OK timestamp on every (re)subscribe — including reconnect-without-prop-change
    // — so the fast-fail-on-exit window measures THIS attach, not a stale prior one.
    this._subscribeOkAt = 0;
    this._log('subscribe', `cols=${this._terminal?.cols} rows=${this._terminal?.rows}`);

    // Listen for mode event before sending subscribe request.
    // Skip when payload mode equals current mode — gateway re-emits the same
    // mode event after each re-subscribe, which otherwise re-runs setupPtyMode
    // / tmuxPoll and can cascade into duplicate terminal.subscribe (~1s SSH
    // attach each).
    this._unsubMode = gateway.subscribe<TerminalModePayload>(Events.TERMINAL_MODE, (p) => {
      if (subscribeSeq !== this._subscribeSeq) return;
      if (!this._matchesTarget(p)) return;
      if (p.mode === this._mode) return;
      this._log('mode-event', `mode=${p.mode}`);
      this._mode = p.mode as TerminalMode;
      if (this._mode === 'pty') {
        this._setupPtyMode();
        this._startTmuxPoll();
      }
    });

    try {
      // gateway-client owns the request timeout (15s default). Wrapping a
      // shorter UI-side race here would discard a slow-but-successful subscribe
      // without cancelling it, leaving the gateway with an orphan pty handler
      // and the UI stuck on the failure banner.
      await gateway.request(
        worker ? Methods.TERMINAL_WORKER_SUBSCRIBE : Methods.TERMINAL_SUBSCRIBE,
        {
          ...this._targetParams(),
          ...(worker ? {} : { interactive: true }),
          cols: this._terminal?.cols,
          rows: this._terminal?.rows,
        },
      );
      this._log('subscribed OK');
      if (subscribeSeq !== this._subscribeSeq) return;
      this._lastSubscribeError = '';
      this._subscribeOkAt = Date.now();
      this._reconnecting = false;
      this._recoveryMessage = '';
    } catch (err) {
      if (subscribeSeq !== this._subscribeSeq) return;
      this._lastSubscribeError = err instanceof Error ? err.message : String(err);
      this._log('subscribe FAILED', String(err));
      this._terminal?.writeln(`\x1b[31m[Failed to subscribe to ${this._targetLabel()}]\x1b[0m`);
      this._reconnecting = gateway.connectionState === 'connected';
      this._recoveryMessage =
        gateway.connectionState === 'connected'
          ? 'Terminal recovery failed — retry or wait for the gateway'
          : 'Waiting for gateway';
      // Bubble only non-retryable failures so the slot-view tab strip does not
      // permanently disable role windows that are still starting or had a slow attach.
      if (
        !worker &&
        gateway.connectionState === 'connected' &&
        !isRetryableTerminalSubscribeError(err)
      ) {
        this.dispatchEvent(
          new CustomEvent('terminal-subscribe-failed', {
            detail: { slotId: this.slotId, contextId: this.contextId, role: this.role },
            bubbles: true,
            composed: true,
          }),
        );
      }
      return;
    }

    this._unsubData = gateway.subscribe(Events.TERMINAL_DATA, (payload: unknown) => {
      if (subscribeSeq !== this._subscribeSeq) return;
      const data = payload as TerminalData;
      if (this._matchesTarget(data)) {
        // In PTY mode, drop data until first resize settles (prevents garbled initial render)
        if (this._mode === 'pty' && !this._ptyReady) return;
        this._dataCount++;
        if (this._dataCount <= 3) {
          const preview = data.data.substring(0, 80).replace(/\x1b/g, 'ESC');
          this._log('data', `#${this._dataCount} len=${data.data.length} "${preview}"`);
        }
        this._terminal?.write(this._interceptOsc52(data.data));
      }
    });

    if (!worker) {
      this._unsubSlot = gateway.subscribe(Events.SLOT_CHANGED, (payload: unknown) => {
        if (subscribeSeq !== this._subscribeSeq) return;
        const slot = payload as SlotStatus;
        if (slot.slot === this.slotId) {
          this._lifecycle = slot.lifecycle;
          this._agent = slot.agent;
          this._runner = slot.runner ?? '';
          this._model = slot.model ?? '';
          this._taskId = slot.taskId || '';
          this._syncRunSummary();
        }
      });
    }

    this._unsubExit = gateway.subscribe<TerminalExitedPayload>(Events.TERMINAL_EXITED, (p) => {
      if (subscribeSeq !== this._subscribeSeq) return;
      if (!this._matchesTarget(p)) return;
      this._log('exited', `code=${p.exitCode}`);
      // Early non-zero exit while bound to a role pane = role window is gone (e.g. tmux
      // select-window failed). Drop the role binding and re-attach to the bare session.
      const exitDecision = terminalRoleExitDecision({
        exitCode: p.exitCode,
        subscribeOkAt: this._subscribeOkAt,
        nowMs: Date.now(),
        fastFailMs: ROLE_PANE_FAST_FAIL_MS,
        role: this.role,
        contextId: this.contextId,
        postmortem: this._postmortem,
      });
      // Observe the empirical bound: log every non-zero role-bound exit with elapsedMs so we
      // can decide whether ROLE_PANE_FAST_FAIL_MS needs to widen. fastFail=false rows here
      // are the "missed" cases — if their elapsedMs cluster just above 3000 we should raise.
      if (exitDecision.shouldLogRoleExit) {
        this._log(
          'role-exit-elapsed',
          `code=${p.exitCode} role=${this.role} elapsedMs=${exitDecision.elapsedSinceOk} fastFail=${exitDecision.fastFail}`,
        );
      }
      if (exitDecision.shouldEnterPostmortem) {
        void this._enterPostmortem(
          `exit code=${p.exitCode} elapsedMs=${exitDecision.elapsedSinceOk}`,
        );
        return;
      }
      this._exited = true;
      // The "Session ended" banner only makes sense for live role attachments. In postmortem
      // we already wrote "[Role pane closed — attaching to bare session for postmortem]"; a
      // second banner just confuses operators reading a still-functional bare session view.
      if (!this._postmortem) {
        this._terminal?.writeln('');
        this._terminal?.writeln('\x1b[33m[Session ended]\x1b[0m');
      }
    });

    if (!worker) this._fetchTaskProgress();

    // Subscribe to real-time task progress updates
    if (!worker) {
      this._unsubTaskProgress = gateway.subscribe<TaskProgressUpdatedPayload>(
        Events.TASK_PROGRESS_UPDATED,
        (p) => {
          if (subscribeSeq !== this._subscribeSeq) return;
          if (this._matchesTarget(p) && p.progress?.markdown) {
            this._taskMarkdown = p.progress.markdown;
          }
        },
      );
    }

    // In poll mode, get initial snapshot (PTY gives full screen immediately)
    setTimeout(async () => {
      if (subscribeSeq !== this._subscribeSeq) return;
      if (this._mode === 'poll') {
        try {
          const snap = await gateway.request<{
            lines: string[];
            timestamp: number;
          }>(worker ? Methods.TERMINAL_WORKER_SNAPSHOT : Methods.TERMINAL_SNAPSHOT, {
            ...this._targetParams(),
            lines: 200,
          });
          if (snap.lines.length) {
            this._terminal?.write(snap.lines.join('\n'));
          }
        } catch (err) {
          this._warn('initial snapshot', err);
        }
      }
    }, 100);
  }

  private _setupPtyMode() {
    if (!this._terminal) return;
    if (this._ptyInputBound) {
      this._log('setupPtyMode skipped', 'input already bound');
      return;
    }
    this._log('setupPtyMode');

    // Disable convertEol in PTY mode — the PTY handles line endings
    this._terminal.options.convertEol = false;

    // Intercept key combos that the browser would swallow before xterm.js sees them.
    // Return false = we handled it (prevent browser + xterm default).
    // Return true  = let xterm.js handle it normally.
    this._terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      const send = (seq: string) => {
        gateway
          .request(this._workerRef() ? Methods.TERMINAL_WORKER_INPUT : Methods.TERMINAL_INPUT, {
            ...this._targetParams(),
            data: seq,
          })
          .catch((err) => this._warn('terminal input', err));
      };

      // Ctrl+B — tmux prefix. Browsers may intercept this (bold shortcut, bookmarks, etc.)
      // Force it through to the PTY.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'b') {
        send('\x02');
        e.preventDefault();
        return false;
      }

      // macOS Cmd+key shortcuts → terminal sequences or clipboard ops
      if (e.metaKey) {
        switch (e.key) {
          case 'c': {
            // Cmd+C: copy selection to clipboard if text is selected, else send Ctrl+C
            const sel = this._terminal?.getSelection();
            if (sel) {
              navigator.clipboard.writeText(sel).catch((err) => this._warn('clipboard copy', err));
              e.preventDefault();
              return false;
            }
            // No selection — send Ctrl+C (SIGINT) to the PTY
            send('\x03');
            e.preventDefault();
            return false;
          }
          case 'v': {
            // Cmd+V: paste from clipboard into the PTY
            navigator.clipboard
              .readText()
              .then((text) => {
                if (text) send(text);
              })
              .catch((err) => this._warn('clipboard paste', err));
            e.preventDefault();
            return false;
          }
          case 'Backspace':
            send('\x15');
            break; // Cmd+Delete → Ctrl+U (kill line)
          case 'ArrowLeft':
            send('\x01');
            break; // Cmd+Left   → Ctrl+A (beginning of line)
          case 'ArrowRight':
            send('\x05');
            break; // Cmd+Right  → Ctrl+E (end of line)
          case 'k':
            send('\x0b');
            break; // Cmd+K      → Ctrl+K (kill to end)
          default:
            return true; // let browser handle other Cmd combos
        }
        e.preventDefault();
        return false;
      }

      return true;
    });

    // Register xterm.js onData — captures all keystrokes, escape sequences, etc.
    this._xtermDataDisposable = this._terminal.onData((data: string) => {
      gateway
        .request(this._workerRef() ? Methods.TERMINAL_WORKER_INPUT : Methods.TERMINAL_INPUT, {
          ...this._targetParams(),
          data,
        })
        .catch((err) => this._warn('terminal input', err));
    });
    this._ptyInputBound = true;

    // Terminal already knows its dimensions — send resize immediately so the
    // PTY gets the correct size and tmux redraws. No need to wait for the
    // ResizeObserver (which won't fire if the container size hasn't changed).
    if (this._terminal.cols > 0 && this._terminal.rows > 0) {
      this._ptyReady = true;
      this._log('immediate-resize', `cols=${this._terminal.cols} rows=${this._terminal.rows}`);
      gateway
        .request(this._workerRef() ? Methods.TERMINAL_WORKER_RESIZE : Methods.TERMINAL_RESIZE, {
          ...this._targetParams(),
          cols: this._terminal.cols,
          rows: this._terminal.rows,
        })
        .catch((err) => this._warn('terminal resize', err));
    }

    // Focus terminal for keyboard capture
    this._terminal.focus();
  }

  private _sendResize() {
    if (this._mode !== 'pty' || !this._terminal) return;
    const first = !this._ptyReady;
    this._ptyReady = true;
    this._log('resize', `cols=${this._terminal.cols} rows=${this._terminal.rows} first=${first}`);
    gateway
      .request(this._workerRef() ? Methods.TERMINAL_WORKER_RESIZE : Methods.TERMINAL_RESIZE, {
        ...this._targetParams(),
        cols: this._terminal.cols,
        rows: this._terminal.rows,
      })
      .catch((err) => this._warn('terminal resize', err));
  }

  private async _fetchTaskProgress() {
    if (!this.slotId) return;
    try {
      const res = await gateway.request<{ slotId: string; markdown: string }>(
        Methods.TASK_PROGRESS,
        this._targetParams(),
      );
      this._taskMarkdown = res.markdown;
    } catch (err) {
      this._warn('task progress fetch', err);
      this._taskMarkdown = '';
    }
  }

  // Tear down stream subscriptions only — keeps terminal + resize observer alive
  private _teardownStreams(remoteUnsubscribe = true) {
    this._log('teardownStreams');
    this._subscribeSeq++;
    this._stopTmuxPoll();
    if (remoteUnsubscribe && this._hasTarget() && gateway.connectionState === 'connected') {
      gateway
        .request(
          this._workerRef() ? Methods.TERMINAL_WORKER_UNSUBSCRIBE : Methods.TERMINAL_UNSUBSCRIBE,
          this._targetParams(),
        )
        .catch((err) => this._warn('terminal unsubscribe', err));
    }
    this._xtermDataDisposable?.dispose();
    this._xtermDataDisposable = undefined;
    this._ptyInputBound = false;
    this._unsubData?.();
    this._unsubSlot?.();
    this._unsubMode?.();
    this._unsubExit?.();
    this._unsubTaskProgress?.();
    clearTimeout(this._resizeTimer);
    this._unsubData = undefined;
    this._unsubSlot = undefined;
    this._unsubMode = undefined;
    this._unsubExit = undefined;
    this._unsubTaskProgress = undefined;
  }

  // Full cleanup — element is being removed from DOM
  private _dispose() {
    this._teardownStreams();
    this._unsubConn?.();
    this._unsubConn = undefined;
    this._xtermSelectionDisposable?.dispose();
    clearTimeout(this._selectionCopyTimer);
    clearTimeout(this._copyToastTimer);
    this._resizeObserver?.disconnect();
    this._terminal?.dispose();
    this._terminal = undefined;
    this._fitAddon = undefined;
  }

  private _handleSend() {
    if (!this._inputText.trim() || !this._hasTarget()) return;
    const worker = this._workerRef();
    gateway
      .request(worker ? Methods.TERMINAL_WORKER_INPUT : Methods.TERMINAL_SEND, {
        ...this._targetParams(),
        ...(worker ? { data: `${this._inputText}\r` } : { text: this._inputText, enter: true }),
      })
      .catch((err) => this._warn('reinit', err));
    this._inputText = '';
  }

  private _handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this._handleSend();
    }
  }

  private _emitTerminalEvent(type: 'terminal-expand' | 'terminal-close') {
    this.dispatchEvent(
      new CustomEvent(type, {
        detail: this._targetParams(),
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleHeaderClick() {
    this._emitTerminalEvent('terminal-expand');
  }

  private _handleCloseClick(event: Event) {
    event.stopPropagation();
    this._emitTerminalEvent('terminal-close');
  }

  private async _handleReconnect() {
    if (!this._hasTarget() || this._reconnecting) return;
    this._reconnecting = true;
    this._recoveryMessage = 'Reinitializing terminal…';
    this._exited = false;
    this._lastSubscribeError = '';
    this._log('reconnect');

    // Immediate visual feedback
    this._terminal?.clear();
    this._terminal?.writeln('\x1b[2m[Reconnecting...]\x1b[0m');

    if (!this._workerRef()) {
      try {
        // Reinit the tmux session (creates it if it was killed)
        await gateway.request(Methods.TERMINAL_REINIT, this._targetParams());
      } catch (err) {
        this._log('reinit FAILED', String(err));
        this._terminal?.writeln(`\x1b[31m[Reinit failed: ${err}]\x1b[0m`);
        this._reconnecting = false;
        this._exited = true;
        return;
      }
    }

    // Tear down old streams (keep resize observer alive) and re-subscribe
    this._teardownStreams();
    this._terminal?.clear();
    this._mode = 'none';
    await this._subscribe();

    // Role pane is gone (worker exited on terminal run state); reinit only restores the bare session.
    if (
      this._reconnecting &&
      (this.role || this.contextId) &&
      !this._postmortem &&
      isRoleWindowMissingError(this._lastSubscribeError)
    ) {
      this._log('postmortem-fallback', `error="${this._lastSubscribeError.slice(0, 200)}"`);
      await this._enterPostmortem(`reconnect error: ${this._lastSubscribeError.slice(0, 80)}`);
    }
  }

  // Drop the role/contextId binding and re-attach to the bare tmux session. Both fast-fail
  // (TERMINAL_EXITED handler) and reconnect-error paths funnel through here so the user-visible
  // message and resubscribe sequence stay in lockstep — one of them drifting is the kind of bug
  // that only shows up after a real blocked-run incident, which is the worst time to debug.
  private async _enterPostmortem(_reason: string): Promise<void> {
    this._postmortem = true;
    this._recoveryMessage = 'Role pane closed — viewing bare session';
    this._terminal?.writeln(
      '\x1b[2m[Role pane closed — attaching to bare session for postmortem]\x1b[0m',
    );
    this._teardownStreams();
    this._mode = 'none';
    await this._subscribe();
  }

  private _handleGatewayConnection(state: import('../../gateway-client.js').ConnectionState) {
    this._connected = state === 'connected';
    if (!this._hasTarget() || !this._terminal) return;

    if (state === 'disconnected') {
      this._log('gateway disconnected');
      this._reconnecting = true;
      this._recoveryMessage = 'Waiting for gateway';
      this._mode = 'none';
      this._exited = false;
      this._teardownStreams(false);
      return;
    }

    if (state === 'connecting') {
      this._reconnecting = true;
      this._recoveryMessage = 'Connecting to gateway…';
      return;
    }

    if (this._reconnecting || !this._unsubData) {
      this._log('gateway connected → passive resubscribe');
      this._reconnecting = true;
      this._recoveryMessage = 'Recovering terminal…';
      this._terminal.clear();
      this._terminal.writeln('\x1b[2m[Recovering terminal from gateway…]\x1b[0m');
      this._mode = 'none';
      void this._subscribe();
    }
  }

  // --- Tmux control ---

  private async _tmuxAction(method: string, params: Record<string, unknown> = {}) {
    try {
      await gateway.request(method, { ...this._targetParams(), ...params });
      // Refresh tmux state after action
      this._refreshTmuxList({ force: true });
    } catch (err) {
      this._log('tmux-action-failed', `method=${method} err=${err}`);
    }
  }

  private async _refreshTmuxList(opts: { force?: boolean } = {}) {
    if (!this.slotId || this._mode !== 'pty') return;
    if (!opts.force && document.hidden) return;
    if (this._tmuxListInFlight) return;
    if (!opts.force && Date.now() < this._tmuxListBackoffUntil) return;
    this._tmuxListInFlight = true;
    try {
      const result = await gateway.request<{
        windows: Array<{
          index: number;
          name: string;
          active: boolean;
          panes: Array<{
            index: number;
            active: boolean;
            width: number;
            height: number;
            title: string;
          }>;
        }>;
      }>(Methods.TMUX_LIST, this._targetParams());
      this._tmuxWindows = result.windows;
      this._tmuxListBackoffUntil = 0;
    } catch (err) {
      this._tmuxListBackoffUntil = Date.now() + TMUX_LIST_ERROR_BACKOFF_MS;
      this._warn('tmux list refresh', err);
    } finally {
      this._tmuxListInFlight = false;
    }
  }

  private _startTmuxPoll() {
    if (this._workerRef()) return;
    this._stopTmuxPoll();
    this._refreshTmuxList({ force: true });
    this._tmuxPollTimer = setInterval(() => this._refreshTmuxList(), TMUX_LIST_POLL_MS);
  }

  private _stopTmuxPoll() {
    if (this._tmuxPollTimer) {
      clearInterval(this._tmuxPollTimer);
      this._tmuxPollTimer = undefined;
    }
  }

  // Send raw data via PTY (for special key sequences)
  private _sendRawKeys(data: string) {
    if (this._mode !== 'pty') return;
    gateway
      .request(this._workerRef() ? Methods.TERMINAL_WORKER_INPUT : Methods.TERMINAL_INPUT, {
        ...this._targetParams(),
        data,
      })
      .catch((err) => this._warn('raw terminal input', err));
    // Re-focus terminal after button click
    this._terminal?.focus();
  }

  // Intercept OSC 52 clipboard sequences from remote tmux and copy to browser clipboard
  // Format: \x1b]52;<selections>;<base64>\x07  or  \x1b]52;<selections>;<base64>\x1b\\
  private _interceptOsc52(data: string): string {
    const result = extractOsc52Clipboard(data, atob);
    for (const text of result.clipboardTexts) {
      this._copyToClipboard(text);
      this._log('osc52', `${text.length} chars`);
    }
    for (const err of result.decodeErrors) {
      this._warn('osc52 clipboard decode', err);
    }
    return result.data;
  }

  private _copyToClipboard(text: string) {
    const showToast = () => {
      this._copyToast = true;
      clearTimeout(this._copyToastTimer);
      this._copyToastTimer = setTimeout(() => {
        this._copyToast = false;
      }, 1500);
    };
    // navigator.clipboard requires document focus — use textarea fallback if it fails
    navigator.clipboard.writeText(text).then(
      () => {
        this._log('auto-copy', `${text.length} chars`);
        showToast();
      },
      () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this._log('auto-copy-fallback', `${text.length} chars`);
        showToast();
      },
    );
  }

  private _toggleSelectMode() {
    this._selectMode = !this._selectMode;
    if (!this._terminal) return;

    if (this._selectMode) {
      // Disable mouse reporting — xterm.js stops capturing mouse, native selection works
      this._terminal.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
      // Auto-copy when selection changes (debounced — copies after user stops selecting)
      this._xtermSelectionDisposable = this._terminal.onSelectionChange(() => {
        clearTimeout(this._selectionCopyTimer);
        this._selectionCopyTimer = setTimeout(() => {
          const sel = this._terminal?.getSelection();
          if (sel) this._copyToClipboard(sel);
        }, 300);
      });
    } else {
      this._xtermSelectionDisposable?.dispose();
      this._xtermSelectionDisposable = undefined;
      clearTimeout(this._selectionCopyTimer);
      // Re-enable: bounce the PTY size so tmux does a full redraw and re-sends mouse mode.
      // A same-size resize is a no-op, so shrink by 1 col then restore.
      const cols = this._terminal.cols;
      const rows = this._terminal.rows;
      gateway
        .request(this._workerRef() ? Methods.TERMINAL_WORKER_RESIZE : Methods.TERMINAL_RESIZE, {
          ...this._targetParams(),
          cols: cols - 1,
          rows,
        })
        .then(() => {
          setTimeout(() => {
            gateway
              .request(
                this._workerRef() ? Methods.TERMINAL_WORKER_RESIZE : Methods.TERMINAL_RESIZE,
                {
                  ...this._targetParams(),
                  cols,
                  rows,
                },
              )
              .catch((err) => this._warn('resize restore', err));
          }, 50);
        })
        .catch((err) => this._warn('resize shrink', err));
    }
    this._terminal.focus();
  }

  private _startRename() {
    const activeWin = this._tmuxWindows.find((w) => w.active);
    this._renameValue = activeWin?.name ?? '';
    this._renaming = true;
  }

  private async _submitRename() {
    if (!this._renameValue.trim()) {
      this._renaming = false;
      return;
    }
    try {
      await gateway.request(Methods.TMUX_RENAME_WINDOW, {
        ...this._targetParams(),
        name: this._renameValue,
      });
      this._renaming = false;
      this._refreshTmuxList({ force: true });
    } catch (err) {
      this._warn('rename window', err);
      this._renaming = false;
    }
    this._terminal?.focus();
  }

  private _renderTmuxToolbar() {
    return renderTmuxToolbar({
      isWorkerTarget: Boolean(this._workerRef()),
      mode: this._mode,
      selectMode: this._selectMode,
      windows: this._tmuxWindows,
      renaming: this._renaming,
      renameValue: this._renameValue,
      setRenameValue: (value) => {
        this._renameValue = value;
      },
      startRename: () => this._startRename(),
      submitRename: () => this._submitRename(),
      cancelRename: () => {
        this._renaming = false;
        this._terminal?.focus();
      },
      toggleSelectMode: () => this._toggleSelectMode(),
      sendRawKeys: (data) => this._sendRawKeys(data),
      tmuxAction: (method, params) => this._tmuxAction(method, params),
    });
  }

  render() {
    const worker = this._workerRef();

    return renderTerminalChrome({
      showInputBar: !this.compact && this._mode !== 'pty',
      isWorkerTarget: Boolean(worker),
      lifecycle: this._lifecycle,
      mode: this._mode,
      agent: this._agent,
      runner: this._runner,
      model: this._model,
      summary: this._summary,
      slotId: this.slotId,
      targetLabel: this._targetLabel(),
      hasTarget: this._hasTarget(),
      taskMarkdown: this._taskMarkdown,
      toolbar: this._renderTmuxToolbar(),
      reconnecting: this._reconnecting,
      recoveryMessage: this._recoveryMessage,
      copyToast: this._copyToast,
      exited: this._exited,
      inputText: this._inputText,
      setInputText: (value) => {
        this._inputText = value;
      },
      onHeaderClick: () => this._handleHeaderClick(),
      onCloseClick: (event) => this._handleCloseClick(event),
      onReconnect: () => this._handleReconnect(),
      onInputKeydown: (event) => this._handleKeydown(event),
      onSend: () => this._handleSend(),
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'terminal-view': TerminalView;
  }
}
