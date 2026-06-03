import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type { FleetRefreshSummaryEvent } from '@farmslot/protocol';

import { ConfirmActionTimer } from '../shared/confirm-action-model.js';

import type {
  FleetRefreshFilterSnapshot,
  FleetRefreshPhase,
  FleetRefreshRowState,
} from './fleet-refresh-modal-model.js';

export const CONFIRM_SELECT_ALL_FORCE = 'select-all-force';
export const CONFIRM_ALLOW_DANGEROUS = 'allow-dangerous';

export abstract class FleetRefreshModalState extends LitElement {
  @property({ type: Boolean }) open = false;

  @state() protected _phase: FleetRefreshPhase = 'loading';
  @state() protected _error = '';
  @state() protected _rows: Map<string, FleetRefreshRowState> = new Map();
  @state() protected _hidden: Array<{ slotId: string; reason: string }> = [];
  @state() protected _expandSafe = true;
  @state() protected _expandForce = true;
  @state() protected _expandHidden = false;
  @state() protected _bulkRequestId = '';
  @state() protected _summary: FleetRefreshSummaryEvent | null = null;
  /** 2-click confirm for destructive review actions. */
  @state() protected _pendingConfirm: string | null = null;
  /**
   * When false (default), force rows whose PR is OPEN or whose PR state is
   * unknown (gh failed / not loaded yet) cannot be selected. Operator
   * explicitly opts in via the "show open-PR slots" toggle which requires
   * a 2-click confirm.
   */
  @state() protected _allowDangerous = false;
  /**
   * Snapshot of the active global filter at modal open. Frozen for the lifetime of one
   * modal session so a filter change mid-review can't silently shrink/grow the visible
   * fleet under the operator. Closing + reopening picks up the latest filter.
   */
  @state() protected _filterSnapshot: FleetRefreshFilterSnapshot = {
    projects: [],
    machines: [],
  };
  @state() protected _filteredOutCount = 0;
  /**
   * True from the moment we kick FLEET_PR_SUMMARY until it resolves or fails. The danger
   * section is only safe to interact with after this clears — without PR state the
   * "I understand — allow open-PR slots" toggle would let operators opt into rows whose
   * PR open-status is genuinely unknown rather than known-clean.
   */
  @state() protected _prAnnotationsLoading = false;
  // Generation counter so a slow PR-summary request from a closed-then-reopened modal can't
  // resolve into the new session and prematurely re-enable the override gate.
  protected _prAnnotationsRequestId = 0;

  protected _unsubs: Array<() => void> = [];
  protected readonly _confirmTimer = new ConfirmActionTimer({
    pendingConfirm: () => this._pendingConfirm,
    setPendingConfirm: (pending) => {
      this._pendingConfirm = pending;
    },
  });

  protected get _pendingSelectAllForce(): boolean {
    return this._pendingConfirm === CONFIRM_SELECT_ALL_FORCE;
  }

  protected get _pendingAllowDangerous(): boolean {
    return this._pendingConfirm === CONFIRM_ALLOW_DANGEROUS;
  }
}
