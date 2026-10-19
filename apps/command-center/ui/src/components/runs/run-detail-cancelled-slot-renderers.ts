import { html, nothing } from 'lit';

import type { CancelledRunSlotChoices, Run } from '@farmslot/protocol';

import type { CancelledRunSlotReplay } from '../shared/cancelled-run-slot-release.js';

import { isFreshDispatchRecovery } from './step-inspector-model.js';

export interface CancelledRunSlotRenderContext {
  choices: CancelledRunSlotChoices | null;
  replayAllowed: boolean;
  onReplayStep: (
    stepName: string,
    skipPrepare?: boolean,
    prepareProfile?: string,
    freshDispatch?: boolean,
  ) => void | Promise<void>;
}

/** A cancelled run's kept slot: replay from the stopped step, or release it (ADR-054, 2026-10-19). */
export function renderCancelledRunSlotChoices(
  run: Run,
  { choices, replayAllowed, onReplayStep }: CancelledRunSlotRenderContext,
): unknown {
  if (!choices) return nothing;
  const stepName = choices.replayStepName;
  const replay: CancelledRunSlotReplay = {
    label: choices.replayLabel,
    disabled: !replayAllowed,
    onReplay: () =>
      void onReplayStep(stepName, undefined, undefined, isFreshDispatchRecovery(run, stepName)),
  };
  return html`<div data-testid="run-cancelled-slot-choices" style="margin-top:4px">
    <cancelled-run-slot-release
      .hold=${choices.hold}
      .replay=${replay}
    ></cancelled-run-slot-release>
  </div>`;
}
