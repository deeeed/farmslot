import { execFileSync } from 'node:child_process';

import { sleepMs } from './common.mjs';
import { capturePane } from './tmux.mjs';
import { detectLaunchBlocker } from './pane-blockers.mjs';

export function sendTmuxKey(paneId, key) {
  execFileSync('tmux', ['send-keys', '-t', paneId, key]);
}

export function sendTmuxLine(paneId, text) {
  execFileSync('tmux', ['send-keys', '-l', '-t', paneId, text]);
  execFileSync('tmux', ['send-keys', '-t', paneId, 'C-m']);
}

export function resolveLaunchBlockers(paneId, runnerId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let trustAnswered = false;
  let projectSelected = false;
  while (Date.now() < deadline) {
    const pane = capturePane(paneId, 80);
    const blocker = detectLaunchBlocker(pane, runnerId);
    if (blocker?.autoAction === 'cursor-trust-workspace' && !trustAnswered) {
      sendTmuxKey(paneId, 'a');
      trustAnswered = true;
      sleepMs(1500);
      continue;
    }
    if (blocker?.autoAction === 'grok-select-current-project' && !projectSelected) {
      sendTmuxKey(paneId, 'Enter');
      projectSelected = true;
      sleepMs(1500);
      continue;
    }
    if (blocker) return { pane, blocker, resolved: false };
    if (!blocker) return { pane, blocker: null, resolved: true, trustAnswered, projectSelected };
    sleepMs(1000);
  }
  return { pane: capturePane(paneId, 80), blocker: null, resolved: false };
}