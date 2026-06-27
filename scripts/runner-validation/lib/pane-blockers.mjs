import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { TMUX_SKILL } from './common.mjs';

/** Delegate to tmux-model-driver pane-state.sh — single source of truth for blocker patterns. */
export function detectLaunchBlocker(pane, runnerId) {
  const lines = String(pane).split('\n').filter((line) => line.trim());
  const env = {
    ...process.env,
    TMUX_PANE_STATE_CURRENT_COMMAND: '',
    TMUX_PANE_STATE_CURRENT_PATH: '',
    TMUX_PANE_STATE_SESSION_NAME: 'detect',
    TMUX_PANE_STATE_PANE_TITLE: '',
    TMUX_PANE_STATE_PANE_PID: '',
    TMUX_PANE_STATE_TAIL_CAPTURE: pane,
    TMUX_PANE_STATE_LAST_LINE: lines.at(-1) || '',
  };
  const out = execFileSync(
    'bash',
    [path.join(TMUX_SKILL, 'pane-state.sh'), '%0', runnerId || ''],
    { env, encoding: 'utf8' },
  );
  const data = JSON.parse(out);
  if (!data.launch_blocker) return null;
  return {
    kind: data.launch_blocker,
    autoAction: data.auto_action,
  };
}