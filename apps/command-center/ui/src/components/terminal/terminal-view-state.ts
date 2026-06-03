import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { LitElement } from 'lit';
import { property, query, state } from 'lit/decorators.js';

import type { AgentRole, TmuxWorkerRef } from '@farmslot/protocol';

import {
  parseWorkerRef,
  terminalHasTarget,
  terminalMatchesTarget,
  terminalTargetLabel,
  terminalTargetParams,
  type TerminalTargetPayload,
  type TerminalTargetState,
} from './terminal-view-model.js';
import type { TerminalMode, TmuxWindowSummary } from './terminal-view-renderers.js';

let terminalInstanceSeq = 0;

export abstract class TerminalViewState extends LitElement {
  @property({ type: String }) slotId = '';
  @property({ type: String }) role: AgentRole | '' = '';
  @property({ type: String }) contextId = '';
  @property({ type: String }) runId = '';
  @property({ type: String }) workerRefJson = '';
  @property({ type: Boolean }) compact = false;

  @state() protected _lifecycle = '';
  @state() protected _agent = '';
  @state() protected _runner = '';
  @state() protected _model = '';
  @state() protected _taskId = '';
  @state() protected _summary = '';
  @state() protected _inputText = '';
  @state() protected _connected = false;
  @state() protected _taskMarkdown = '';
  @state() protected _mode: TerminalMode = 'none';
  @state() protected _exited = false;
  @state() protected _reconnecting = false;
  @state() protected _recoveryMessage = '';
  // Drops role/contextId/runId from subscribe so a dead role pane falls back to bare-session postmortem view.
  @state() protected _postmortem = false;
  protected _lastSubscribeError = '';
  protected _subscribeOkAt = 0;
  @state() protected _tmuxWindows: TmuxWindowSummary[] = [];
  @state() protected _renaming = false;
  @state() protected _renameValue = '';
  @state() protected _selectMode = false;
  @state() protected _copyToast = false;

  @query('.terminal-container') protected _termContainer!: HTMLDivElement;
  @query('.input-field') protected _inputField!: HTMLInputElement;

  protected _terminal?: Terminal;
  protected _fitAddon?: FitAddon;
  protected _unsubData?: () => void;
  protected _unsubSlot?: () => void;
  protected _unsubMode?: () => void;
  protected _unsubConn?: () => void;
  protected _unsubExit?: () => void;
  protected _unsubTaskProgress?: () => void;
  protected _resizeObserver?: ResizeObserver;
  protected _xtermDataDisposable?: { dispose(): void };
  protected _xtermSelectionDisposable?: { dispose(): void };
  protected _selectionCopyTimer?: ReturnType<typeof setTimeout>;
  protected _copyToastTimer?: ReturnType<typeof setTimeout>;
  protected _instanceId = ++terminalInstanceSeq;
  protected _dataCount = 0;
  protected _resizeTimer?: ReturnType<typeof setTimeout>;
  protected _tmuxPollTimer?: ReturnType<typeof setInterval>;
  protected _tmuxListInFlight = false;
  protected _tmuxListBackoffUntil = 0;
  protected _ptyReady = false; // true after first resize settles
  protected _subscribeSeq = 0;
  protected _ptyInputBound = false;

  protected _workerRef(): TmuxWorkerRef | null {
    return parseWorkerRef(this.workerRefJson);
  }

  protected _targetState(): TerminalTargetState {
    return {
      slotId: this.slotId,
      runId: this.runId,
      role: this.role,
      contextId: this.contextId,
      worker: this._workerRef(),
      postmortem: this._postmortem,
    };
  }

  protected _hasTarget(): boolean {
    return terminalHasTarget(this._targetState());
  }

  protected _targetLabel(): string {
    return terminalTargetLabel(this._targetState());
  }

  protected _targetParams() {
    return terminalTargetParams(this._targetState());
  }

  protected _matchesTarget(p: TerminalTargetPayload): boolean {
    return terminalMatchesTarget(this._targetState(), p);
  }

  protected _log(action: string, detail?: string) {
    const parts = [`[terminal #${this._instanceId}] ${action}`];
    const worker = this._workerRef();
    if (worker) parts.push(`worker=${worker.nodeId}:${worker.target}`);
    else if (this.slotId) parts.push(`slot=${this.slotId}`);
    parts.push(`mode=${this._mode}`);
    if (detail) parts.push(detail);
    console.log(parts.join(' '));
  }

  protected _warn(action: string, err: unknown) {
    console.warn(
      `[terminal #${this._instanceId}] ${action} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
