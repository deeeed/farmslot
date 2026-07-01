import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { farmslotRoot } from '../core/config.js';

function normalizeRunnerId(runnerId?: string | null): string {
  return String(runnerId ?? '')
    .trim()
    .toLowerCase();
}

const PANE_STATE_SCRIPT = path.join(
  farmslotRoot,
  '.agents/skills/tmux-model-driver/scripts/pane-state.sh',
);

export interface PaneStateScriptResult {
  state: string;
  phase: string;
  confidence: string;
  launchBlocker: string | null;
  autoAction: string | null;
}

const UNAVAILABLE_PANE_STATE: PaneStateScriptResult = {
  state: 'unknown',
  phase: 'idle',
  confidence: 'low',
  launchBlocker: null,
  autoAction: null,
};

/** Invoke tmux-model-driver pane-state.sh against captured pane text (single source of truth). */
export function readPaneStateFromCapture(
  pane: string,
  runnerId?: string | null,
): PaneStateScriptResult {
  const lines = pane.split('\n').filter((line) => line.trim());
  const env = {
    ...process.env,
    TMUX_PANE_STATE_CURRENT_COMMAND: '',
    TMUX_PANE_STATE_CURRENT_PATH: '',
    TMUX_PANE_STATE_SESSION_NAME: 'capture',
    TMUX_PANE_STATE_PANE_TITLE: '',
    TMUX_PANE_STATE_PANE_PID: '',
    TMUX_PANE_STATE_TAIL_CAPTURE: pane,
    TMUX_PANE_STATE_LAST_LINE: lines.at(-1) ?? '',
  };
  try {
    const out = execFileSync('bash', [PANE_STATE_SCRIPT, '%0', normalizeRunnerId(runnerId)], {
      env,
      encoding: 'utf8',
    });
    const data = JSON.parse(out) as {
      state?: string;
      phase?: string;
      confidence?: string | number;
      launch_blocker?: string | null;
      auto_action?: string | null;
    };
    return {
      state: data.state ?? 'unknown',
      phase: data.phase ?? 'idle',
      confidence: String(data.confidence ?? 'low'),
      launchBlocker: data.launch_blocker ?? null,
      autoAction: data.auto_action ?? null,
    };
  } catch (error) {
    console.warn(
      `[pane-state] pane-state.sh unavailable, falling back to regex heuristics: ${(error as Error).message}`,
    );
    return UNAVAILABLE_PANE_STATE;
  }
}
