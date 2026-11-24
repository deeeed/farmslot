import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayPostLaunchPrompt } from '../lib/gateway-post-launch.mjs';
import { capturePane, killSession, tmux } from '../lib/tmux.mjs';

export const SCENARIO_ID = 'dispatch-prompt-deadline';

const MESSAGE = 'Read and execute TASK.md in this repository';
const READY_TIMEOUT_MS = 6_000;

// A Claude-shaped TUI that never settles: a ticking spinner (`busy`), or a live composer already
// holding the task instruction above a ticking status line (`buffered`). It logs every key it
// receives and, in `buffered` mode, starts "working" on Enter. Named `claude` so the gateway's
// input guard sees the runner.
const FAKE_TUI = `#!/usr/bin/env node
const fs = require('node:fs');
const [mode, messageFile, keyLog] = process.argv.slice(2);
const message = fs.readFileSync(messageFile, 'utf8').trim();
let ticks = 0;
let submitted = false;
const draw = () => {
  process.stdout.write('\\x1b[2J\\x1b[H');
  if (submitted) return process.stdout.write('⏺ Reading TASK.md\\n✻ Working…\\n');
  ticks += 1;
  if (mode === 'buffered')
    process.stdout.write(
      '────────────────\\n❯ ' + message + '\\n────────────────\\nctx:12% · ' + ticks + 's\\n',
    );
  else process.stdout.write('✻ Working… (' + ticks + 's)\\n');
};
setInterval(draw, 1000);
draw();
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  fs.appendFileSync(keyLog, JSON.stringify(data.toString('latin1')) + '\\n');
  if (mode === 'buffered' && (data.includes(13) || data.includes(10))) {
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
  fs.mkdirSync(bin);
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
      `${path.join(bin, 'claude')} ${mode} ${messageFile} ${keyLog}`,
    ]);
    sleepMs(1500);
    const paneId = tmux(['display-message', '-p', '-t', session, '#{pane_id}']);
    const started = Date.now();
    const result = runGatewayPostLaunchPrompt({
      repo,
      target: paneId,
      runner: 'claude',
      message: MESSAGE,
      marker: 'TASK.md',
      timeoutMs: READY_TIMEOUT_MS,
      artifactsDir,
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

/**
 * Real tmux, real gateway `sendRunnerPostLaunchPrompt`, a scripted TUI (no model):
 * - `buffered`: the instruction sits in the live composer above a status line that never settles.
 *   At the readiness deadline it is handed to delivery, which sends the submit key once and
 *   types nothing.
 * - `busy`: a spinner that never settles gets one more readiness window, then fails naming both
 *   waits and writing the ready-timeout snapshot, with no key sent.
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
  const report = { runner, buffered: null, busy: null, pass: false, error: null };
  try {
    report.buffered = runCase('buffered', root);
    const typed = report.buffered.keys.filter((key) => !/^[\r\n]+$/.test(key));
    const submits = report.buffered.keys.filter((key) => /^[\r\n]+$/.test(key));
    if (submits.length !== 1 || typed.length !== 0)
      throw new Error(
        `buffered: expected one submit key and no typed text, got ${JSON.stringify(report.buffered.keys)}`,
      );

    report.busy = runCase('busy', root);
    if (report.busy.result.ok) throw new Error('busy: a never-settling runner was accepted');
    if (!/and \d+s more after the deadline/.test(report.busy.result.error ?? ''))
      throw new Error(`busy: the failure does not name both waits: ${report.busy.result.error}`);
    if (!report.busy.snapshotWritten) throw new Error('busy: no ready-timeout snapshot');
    if (report.busy.keys.length) throw new Error(`busy: keys were sent: ${report.busy.keys}`);
    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  }
  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
