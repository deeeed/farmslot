import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runGatewayMonitorStuck } from '../lib/gateway-post-launch.mjs';
import {
  capturePane,
  ensureShellSession,
  killSession,
  paneState,
  sendShellScript,
  tmux,
} from '../lib/tmux.mjs';
import { resolveLaunchBlockers } from '../lib/tmux-input.mjs';

export const SCENARIO_ID = 'monitor-stuck-smoke';

const BUSY_PROMPT =
  'Start immediately. Run this exact shell command and wait for it to finish: sleep 25 && echo CURSOR_BUSY_OK. Do not ask questions.';

function panePid(paneId) {
  return tmux(['display-message', '-p', '-t', paneId, '#{pane_pid}']);
}

function agentChildAlive(panePid) {
  try {
    const rows = execFileSync('ps', ['-axo', 'ppid=,pid=,comm='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim().split(/\s+/, 3))
      .filter((parts) => parts.length >= 3);
    const kids = new Map();
    for (const [ppid, pid, comm] of rows) {
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push({ pid, comm });
    }
    const stack = [String(panePid)];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const child of kids.get(cur) ?? []) {
        if (/(cursor-)?agent/.test(child.comm ?? '')) return true;
        stack.push(child.pid);
      }
    }
    return false;
  } catch {
    return false;
  }
}

function waitForLiveCursor(paneId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = paneState(paneId);
    const pid = String(last?.pane_pid ?? panePid(paneId));
    const title = String(last?.pane_title ?? '');
    if (agentChildAlive(pid)) return last;
    if (/Run Shell Command/i.test(title)) return last;
    if (last?.state === 'cursor' || last?.state === 'busy') return last;
    sleepMs(500);
  }
  return last;
}

export async function runScenario({ runnerAdapter, timeoutMs, keepSession, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  if (runner !== 'cursor') {
    const report = {
      runner,
      skipped: true,
      skipReason:
        'false stuck-nudge regression is the cursor-agent interactive TUI; this scenario is cursor-only',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }
  if (typeof runnerAdapter.buildBusyLaunchCommand !== 'function') {
    const report = {
      runner,
      skipped: true,
      skipReason: 'cursor adapter missing buildBusyLaunchCommand',
      pass: false,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: false, skipped: true, report };
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-cursor-stuck-'));
  const session = `runner-validate-cursor-${SCENARIO_ID}-${process.pid}`;
  let paneId = null;
  const report = {
    runner,
    repo,
    session,
    launchMode: 'cursor-busy-tui',
    paneState: null,
    probe: null,
    runnerAlive: false,
    wouldNudge: null,
    stuck: null,
    kind: null,
    pass: false,
    error: null,
    paneTail: null,
  };

  try {
    runnerAdapter.prepareRepo?.(repo);
    runnerAdapter.assertBinary?.();
    const shell = ensureShellSession(session, repo);
    paneId = shell.paneId;
    sendShellScript(paneId, repo, [runnerAdapter.buildBusyLaunchCommand(BUSY_PROMPT)]);
    const blockers = resolveLaunchBlockers(paneId, runner, Math.min(timeoutMs, 45_000));
    report.trustResolved = Boolean(blockers.resolved || blockers.trustAnswered);
    const live = waitForLiveCursor(paneId, Math.min(timeoutMs, 90_000));
    report.paneState = live;
    const pid = panePid(paneId);
    report.panePid = pid;
    report.paneTail = capturePane(paneId, 40);
    report.probe = runGatewayMonitorStuck({
      repo,
      target: paneId,
      runner,
      panePid: pid,
      timeoutMs: 30_000,
    });
    if (!report.probe?.ok) {
      throw new Error(report.probe?.error || 'production stuck probe failed');
    }
    report.kind = report.probe.kind;
    report.stuck = report.probe.stuck;
    report.wouldNudge = report.probe.wouldNudge;
    report.runnerAlive = report.probe.runnerAlive === true;
    if (!report.runnerAlive) {
      throw new Error('cursor-agent was not alive under the pane at probe time');
    }
    if (report.wouldNudge || report.stuck) {
      throw new Error(
        `live cursor-agent would have been stuck-nudged (kind=${report.kind} stuck=${report.stuck})`,
      );
    }
    if (report.kind !== 'unproven') {
      throw new Error(`expected unproven cursor activity, got ${report.kind}`);
    }
    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
    report.paneTail = paneId ? capturePane(paneId, 80) : report.paneTail;
  } finally {
    if (!keepSession) {
      killSession(session);
      try {
        fs.rmSync(repo, { recursive: true, force: true });
      } catch {
        // temp dir cleanup is best-effort after evidence is written
      }
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
