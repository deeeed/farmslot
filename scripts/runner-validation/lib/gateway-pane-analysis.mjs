import { spawnSync } from 'node:child_process';
import os from 'node:os';

import { ROOT } from './common.mjs';

/** Mirror pre-fix runnerPaneLooksIdle: composer tail only, ignores status-bar blockers. */
export function oldTailOnlyRunnerPaneLooksIdle(lines, runnerId = 'grok') {
  const tail = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);
  const tailText = tail.join('\n');
  if (/starting session/i.test(tailText)) return false;
  if (runnerId === 'grok') {
    return tail.some((line) => /(^|[│┃\s])❯(?:\s|[│┃]|$)/.test(line));
  }
  return false;
}

export function parseMcpProgress(pane) {
  const match = String(pane).match(/\bmcp\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i);
  if (!match) return null;
  const ready = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(ready) || !Number.isFinite(total) || total <= 0) return null;
  return { ready, total, loading: ready < total };
}

export function analyzeRunnerPane(pane, runnerId = 'grok') {
  const oldTailOnlyIdle = oldTailOnlyRunnerPaneLooksIdle(pane.split('\n'), runnerId);
  const snippet = `
import {
  detectRunnerLaunchBlocker,
  runnerPaneHasDeferredLaunchBlocker,
  runnerPaneLooksIdle,
} from './services/gateway/src/runners/registry.ts';

const pane = ${JSON.stringify(pane)};
const runner = ${JSON.stringify(runnerId)};
const lines = pane.split('\\n');

console.log(JSON.stringify({
  launchBlocker: detectRunnerLaunchBlocker(pane, runner),
  deferred: runnerPaneHasDeferredLaunchBlocker(pane, runner),
  runnerPaneLooksIdle: runnerPaneLooksIdle(lines, runner),
  oldTailOnlyIdle: ${JSON.stringify(oldTailOnlyIdle)},
}));
`;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FARMSLOT_HOME: process.env.FARMSLOT_HOME ?? `${os.homedir()}/.farmslot-dev`,
    },
  });
  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  if (!jsonLine) {
    throw new Error(result.stderr?.trim() || stdout || 'gateway pane analysis failed');
  }
  return JSON.parse(jsonLine);
}

export function promptAcceptedAfterForceSend({
  paneBefore,
  paneAfter,
  message,
  marker,
  runnerId = 'grok',
}) {
  const snippet = `
import { runnerPaneShowsPromptAccepted } from './services/gateway/src/runners/registry.ts';
console.log(JSON.stringify({
  accepted: runnerPaneShowsPromptAccepted(
    ${JSON.stringify(paneAfter)},
    ${JSON.stringify(paneBefore)},
    ${JSON.stringify(message)},
    ${JSON.stringify(marker)},
    ${JSON.stringify(runnerId)},
  ),
}));
`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FARMSLOT_HOME: process.env.FARMSLOT_HOME ?? `${os.homedir()}/.farmslot-dev`,
    },
  });
  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  if (!jsonLine) {
    throw new Error(result.stderr?.trim() || stdout || 'prompt acceptance analysis failed');
  }
  return JSON.parse(jsonLine).accepted;
}
