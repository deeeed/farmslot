import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayPostLaunchPrompt } from '../lib/gateway-post-launch.mjs';
import { capturePane, killSession, tmux, waitForPaneMatch } from '../lib/tmux.mjs';

export const SCENARIO_ID = 'dispatch-prompt-deadline';

const MESSAGE = 'Read and execute TASK.md in this repository';
const DRAFT = 'wait, use the other branch';
const READY_TIMEOUT_MS = 6_000;

// A Claude-shaped TUI that never settles, so readiness always reaches its deadline. Modes:
// - busy: a ticking spinner;
// - buffered: the task instruction already in the live composer, above a ticking status line;
// - idle: an empty composer above a ticking status line, with an idle statusline signal;
// - idle-draft: an operator's draft in the composer, with the same idle signal.
// It logs every key it receives and starts "working" on Enter. Named `claude` so the gateway's
// input guard sees the runner.
const FAKE_TUI = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [mode, messageFile, draft, keyLog, obsDir] = process.argv.slice(2);
const message = fs.readFileSync(messageFile, 'utf8').trim();
const composerText = mode === 'buffered' ? message : mode === 'idle-draft' ? draft : '';
let ticks = 0;
let submitted = false;
const draw = () => {
  if (mode.startsWith('idle'))
    fs.writeFileSync(
      path.join(obsDir, 'statusline.json'),
      JSON.stringify({ busy: false, observedAt: Date.now(), tmuxPane: process.env.TMUX_PANE }),
    );
  process.stdout.write('\\x1b[2J\\x1b[H');
  if (submitted) return process.stdout.write('⏺ Reading TASK.md\\n✻ Working…\\n');
  ticks += 1;
  if (mode === 'busy') return process.stdout.write('✻ Working… (' + ticks + 's)\\n');
  process.stdout.write(
    '────────────────\\n❯ ' + composerText + '\\n────────────────\\nctx:12% · ' + ticks + 's\\n',
  );
};
setInterval(draw, 1000);
draw();
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  fs.appendFileSync(keyLog, JSON.stringify(data.toString('latin1')) + '\\n');
  if (data.includes(13) || data.includes(10)) {
    submitted = true;
    draw();
  }
});
`;

function keysReceived(keyLog) {
  if (!fs.existsSync(keyLog)) return [];
  return fs
    .readFileSync(keyLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runCase(mode, root) {
  const repo = fs.mkdtempSync(path.join(root, `${mode}-`));
  const bin = path.join(repo, 'bin');
  const obsDir = path.join(repo, '.observability');
  fs.mkdirSync(bin);
  fs.mkdirSync(obsDir);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_TUI, { mode: 0o755 });
  const messageFile = path.join(repo, 'message.txt');
  const keyLog = path.join(repo, 'keys.log');
  fs.writeFileSync(messageFile, MESSAGE);
  const session = `runner-validate-${SCENARIO_ID}-${mode}-${process.pid}`;
  const artifactsDir = path.join(repo, '.artifacts', 'runner-blockers');
  try {
    tmux([
      'new-session',
      '-d',
      '-s',
      session,
      '-x',
      '160',
      '-y',
      '40',
      '-c',
      repo,
      `${path.join(bin, 'claude')} ${mode} ${messageFile} '${DRAFT}' ${keyLog} ${obsDir}`,
    ]);
    const paneId = tmux(['display-message', '-p', '-t', session, '#{pane_id}']);
    if (!waitForPaneMatch(paneId, (pane) => /Working|ctx:12%/.test(pane), 10_000, 200))
      throw new Error(`${mode}: the scripted TUI never drew`);
    const started = Date.now();
    const result = runGatewayPostLaunchPrompt({
      repo,
      target: paneId,
      runner: 'claude',
      message: MESSAGE,
      marker: 'TASK.md',
      timeoutMs: READY_TIMEOUT_MS,
      artifactsDir,
      runnerObservabilityDir: obsDir,
    });
    return {
      mode,
      elapsedMs: Date.now() - started,
      result,
      keys: keysReceived(keyLog),
      snapshotWritten: fs.existsSync(path.join(artifactsDir, 'dispatch-launch.txt')),
      paneTail: capturePane(paneId, 12),
    };
  } finally {
    killSession(session);
  }
}

const isSubmit = (key) => /^[\r\n]+$/.test(key);
const typedText = (keys) => keys.filter((key) => !isSubmit(key)).join('');
// The scripted TUI has no hooks, so an exact-ack delivery ends "uncertain", never a plain send
// failure or a readiness timeout.
const UNACKNOWLEDGED = /Exact prompt acknowledgement did not arrive/;
const BOTH_WAITS = /and \d+s more after the deadline/;

function check(report) {
  const { buffered, busy, idle, idleDraft } = report;
  if (buffered.keys.filter(isSubmit).length !== 1 || typedText(buffered.keys))
    throw new Error(`buffered: expected one submit key only, got ${JSON.stringify(buffered.keys)}`);
  if (!UNACKNOWLEDGED.test(buffered.result.error ?? ''))
    throw new Error(`buffered: delivery did not end unacknowledged: ${buffered.result.error}`);
  if (busy.result.ok) throw new Error('busy: a never-settling runner was accepted');
  if (!BOTH_WAITS.test(busy.result.error ?? ''))
    throw new Error(`busy: the failure does not name both waits: ${busy.result.error}`);
  if (!busy.snapshotWritten) throw new Error('busy: no ready-timeout snapshot');
  if (busy.keys.length) throw new Error(`busy: keys were sent: ${busy.keys}`);
  if (typedText(idle.keys) !== MESSAGE || idle.keys.filter(isSubmit).length !== 1)
    throw new Error(
      `idle: expected the instruction once, then one submit: ${JSON.stringify(idle.keys)}`,
    );
  if (!UNACKNOWLEDGED.test(idle.result.error ?? ''))
    throw new Error(`idle: delivery did not end unacknowledged: ${idle.result.error}`);
  if (idleDraft.keys.length)
    throw new Error(`idle-draft: keys were sent over a draft: ${JSON.stringify(idleDraft.keys)}`);
  if (!BOTH_WAITS.test(idleDraft.result.error ?? ''))
    throw new Error(
      `idle-draft: expected the extra window, then failure: ${idleDraft.result.error}`,
    );
}

/**
 * Real tmux, the real gateway `sendRunnerPostLaunchPrompt`, a scripted TUI (no model). At the
 * readiness deadline:
 * - `buffered`: the instruction in the live composer is handed to delivery, which sends the
 *   submit key once, types nothing, and ends through its own unacknowledged-delivery error;
 * - `idle`: an idle signal over an empty composer hands the runner to delivery, which types the
 *   instruction;
 * - `idle-draft`: the same idle signal over an operator's draft hands over nothing;
 * - `busy`: one more readiness window, then a failure naming both waits, with the ready-timeout
 *   snapshot written and no key sent.
 */
export async function runScenario({ runnerAdapter, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'claude') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'dispatch-prompt-deadline drives a scripted Claude-shaped TUI only',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }
  execFileSync('tmux', ['-V'], { stdio: 'pipe' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `runner-validate-${SCENARIO_ID}-`));
  const report = { runner, pass: false, error: null };
  try {
    report.buffered = runCase('buffered', root);
    report.busy = runCase('busy', root);
    report.idle = runCase('idle', root);
    report.idleDraft = runCase('idle-draft', root);
    check(report);
    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    // A killed TUI can still be rewriting its statusline for a moment.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
