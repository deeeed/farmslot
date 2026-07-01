import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { sleepMs, TMUX_SKILL } from './common.mjs';

export function tmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf8' }).trim();
}

export function hasSession(name) {
  try {
    tmux(['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

export function killSession(name) {
  if (!hasSession(name)) return;
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe' });
  } catch {
    // session may have already exited when the runner command finished
  }
}

export function capturePane(paneId, lines = 40) {
  return tmux(['capture-pane', '-p', '-t', paneId, '-S', `-${lines}`]);
}

export function paneState(paneId) {
  return JSON.parse(
    execFileSync('bash', [path.join(TMUX_SKILL, 'pane-state.sh'), paneId], { encoding: 'utf8' }),
  );
}

export function sendShell(paneId, command) {
  execFileSync('bash', [path.join(TMUX_SKILL, 'send-and-verify.sh'), paneId, 'shell'], {
    input: command,
    encoding: 'utf8',
  });
}

/** Avoid tmux send-keys line-wrap splitting long runner launch lines. */
export function sendShellScript(paneId, repo, bodyLines) {
  const script = path.join(TMUX_SKILL, 'send-shell-script.sh');
  execFileSync('bash', [script, paneId, repo], {
    input: `${bodyLines.join('\n')}\n`,
    encoding: 'utf8',
  });
}

export function ensureShellSession(sessionName, repo) {
  if (!hasSession(sessionName)) {
    tmux(['new-session', '-d', '-s', sessionName, '-c', repo, 'bash', '--noprofile', '--norc']);
  }
  sleepMs(500);
  const paneId = tmux(['display-message', '-p', '-t', sessionName, '#{pane_id}']);
  return { sessionName, paneId };
}

export function waitForPaneMatch(paneId, predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = capturePane(paneId, 80);
    if (predicate(pane)) return pane;
    sleepMs(intervalMs);
  }
  const pane = capturePane(paneId, 80);
  return predicate(pane) ? pane : null;
}
