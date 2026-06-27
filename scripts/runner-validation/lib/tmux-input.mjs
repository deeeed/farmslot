import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { TMUX_SKILL } from './common.mjs';
import { capturePane } from './tmux.mjs';

export function sendTmuxKey(paneId, key) {
  execFileSync('tmux', ['send-keys', '-t', paneId, key]);
}

export function sendTmuxLine(paneId, text) {
  execFileSync('tmux', ['send-keys', '-l', '-t', paneId, text]);
  execFileSync('tmux', ['send-keys', '-t', paneId, 'C-m']);
}

/** Delegate to tmux-model-driver resolve-launch-blockers.sh. */
export function resolveLaunchBlockers(paneId, runnerId, timeoutMs = 60000) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const script = path.join(TMUX_SKILL, 'resolve-launch-blockers.sh');
  try {
    const out = execFileSync('bash', [script, paneId, runnerId, String(timeoutSeconds)], {
      encoding: 'utf8',
    });
    const result = JSON.parse(out);
    return {
      pane: capturePane(paneId, 80),
      blocker: null,
      resolved: Boolean(result.resolved),
      trustAnswered: Boolean(result.trust_answered),
      projectSelected: Boolean(result.project_selected),
    };
  } catch (error) {
    const stdout = error?.stdout?.toString?.() || '';
    if (stdout.trim()) {
      const result = JSON.parse(stdout);
      const blocker =
        result.launch_blocker != null
          ? { kind: result.launch_blocker, autoAction: result.auto_action ?? null }
          : null;
      return {
        pane: capturePane(paneId, 80),
        blocker,
        resolved: Boolean(result.resolved),
        trustAnswered: Boolean(result.trust_answered),
        projectSelected: Boolean(result.project_selected),
      };
    }
    return { pane: capturePane(paneId, 80), blocker: null, resolved: false };
  }
}