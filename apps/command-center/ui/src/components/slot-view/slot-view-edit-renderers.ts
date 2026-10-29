import { html, nothing } from 'lit';

import type { SlotView } from './slot-view.js';
import {
  copySlotViewDraft,
  discardSlotViewDraft,
  keepMineSlotViewConflict,
  keepTheirsSlotViewConflict,
  slotViewEditable,
  slotViewFileChangedPath,
  slotViewReadOnly,
  slotViewSaveState,
} from './slot-view-edit-effects.js';
import { slotViewGateWarning } from './slot-view-edit-model.js';

const SAVE_STATE_LABELS = {
  saved: '',
  saving: 'Saving…',
  draft: 'Unsaved',
  conflict: 'Conflict',
  refused: 'Not saved',
} as const;

/** The editor header's save control, or why the file is read-only (decision 4). */
export function renderSlotViewSaveControl(view: SlotView) {
  const path = view._activeFile;
  if (!slotViewEditable(view, path)) {
    const reason = view._isLive ? (slotViewReadOnly(view, path) ?? 'hash') : 'offline';
    return html`<span
      class="sv-read-only"
      data-testid="editor-read-only"
      data-reason=${reason}
      title="Editing needs the gateway's conditional writes, a host that checks them, and a current read of this file."
      >Read-only</span
    >`;
  }
  const state = slotViewSaveState(view, path);
  return html`<span class="sv-save-state" data-testid="file-save-state" data-state=${state}
      >${SAVE_STATE_LABELS[state]}</span
    >
    <button
      class="sv-save-btn ${view._saveFeedback}"
      data-testid="file-save"
      ?disabled=${view._saveFeedback === 'saving'}
      @click=${view._saveFile}
      title="Save (writes to disk)"
    >
      ${view._saveFeedback === 'saving'
        ? 'Saving...'
        : view._saveFeedback === 'saved'
          ? 'Saved'
          : 'Save'}
    </button>`;
}

/**
 * Editing notices above the editor: the pending-gate warning, a refused save with both versions,
 * a worker's write over a save, and this slot's drafts. Hidden drafts are never listed.
 */
export function renderSlotViewEditStrip(view: SlotView) {
  const path = view._activeFile;
  const conflict = view._saveConflict?.path === path ? view._saveConflict : undefined;
  const gate =
    Boolean(path) &&
    slotViewEditable(view, path) &&
    slotViewGateWarning(view._linkedRun, view._slot);
  const changed = slotViewFileChangedPath(view);
  const drafts = view._slotDrafts.filter((draft) => draft.state !== 'hidden');
  if (!conflict && !gate && !view._editNotice && !changed && drafts.length === 0) return nothing;
  return html`<div class="sv-edit-strip">
    ${gate
      ? html`<p role="status" data-testid="save-review-warning">
          This run is at a pending gate. Saving changes the reviewed package, which then needs a new
          review.
        </p>`
      : nothing}
    ${changed
      ? html`<p role="status" data-testid="file-changed-notice">
          ${changed} changed after you saved it. Your version is kept as a draft.
        </p>`
      : nothing}
    ${view._editNotice
      ? html`<p role="status" data-testid="slot-edit-notice">${view._editNotice}</p>`
      : nothing}
    ${conflict
      ? html`<div class="sv-edit-conflict" role="alert" data-testid="draft-conflict">
          <p>The file changed before your save. Keep one version.</p>
          <div class="sv-edit-versions">
            <figure>
              <figcaption>Your version</figcaption>
              <pre data-testid="draft-conflict-mine">${conflict.mine}</pre>
            </figure>
            <figure>
              <figcaption>Current file</figcaption>
              <pre data-testid="draft-conflict-theirs">${conflict.theirs ?? 'Unavailable'}</pre>
            </figure>
          </div>
          <button
            data-testid="draft-keep-mine"
            ?disabled=${view._saveFeedback === 'saving'}
            @click=${() => void keepMineSlotViewConflict(view)}
          >
            Keep mine
          </button>
          <button
            data-testid="draft-keep-theirs"
            @click=${() => void keepTheirsSlotViewConflict(view)}
          >
            Keep the current file
          </button>
        </div>`
      : nothing}
    ${drafts.length
      ? html`<details class="sv-edit-drafts" open>
          <summary>Drafts (${drafts.length})</summary>
          ${drafts.map(
            (draft) =>
              html`<div
                class="sv-edit-draft"
                data-testid="draft-item"
                data-slot=${draft.slotId}
                data-path=${draft.path}
                data-run=${draft.runId ?? ''}
                data-state=${draft.state === 'stale-run' ? 'stale-run' : 'editable'}
              >
                <span class="sv-edit-draft-path">${draft.path}</span>
                ${draft.state === 'stale-run'
                  ? html`<span class="sv-edit-draft-state">
                        Read-only: run ${draft.runId ?? 'none'} is no longer current
                      </span>
                      <button
                        data-testid="draft-copy"
                        @click=${() => void copySlotViewDraft(draft)}
                      >
                        Copy
                      </button>`
                  : html`<button
                      data-testid="draft-open"
                      @click=${() => void view._handleFileSelect(draft.path)}
                    >
                      Open
                    </button>`}
                <button
                  data-testid="draft-discard"
                  @click=${() => void discardSlotViewDraft(view, draft)}
                >
                  Discard
                </button>
              </div>`,
          )}
        </details>`
      : nothing}
  </div>`;
}
