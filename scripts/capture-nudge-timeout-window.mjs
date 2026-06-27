#!/usr/bin/env node
/**
 * Aggregate Run.metrics.nudgeTimeoutCount over a rolling window from the gateway run store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    runsDir: path.join(ROOT, '.runs'),
    windowDays: 7,
    runner: 'claude',
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--runs-dir') args.runsDir = path.resolve(argv[++i]);
    else if (token === '--window-days') args.windowDays = Number(argv[++i]);
    else if (token === '--runner') args.runner = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--help' || token === '-h') {
      console.log(
        'usage: capture-nudge-timeout-window.mjs [--runs-dir <path>] [--window-days 7] [--runner claude] [--out report.json]',
      );
      process.exit(0);
    }
  }
  return args;
}

function loadRunsInWindow(runsDir, cutoffMs) {
  if (!fs.existsSync(runsDir)) return [];
  const runs = [];
  for (const file of fs.readdirSync(runsDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(runsDir, file);
    let run;
    try {
      run = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const ts = run.updatedAt ?? run.createdAt;
    if (!ts) continue;
    const when = Date.parse(ts);
    if (Number.isNaN(when) || when < cutoffMs) continue;
    runs.push(run);
  }
  return runs;
}

function summarize(runs, runnerFilter) {
  const filtered = runs.filter((run) => run.metrics?.runner === runnerFilter);
  const timeoutRuns = filtered.filter((run) => (run.metrics?.nudgeTimeoutCount ?? 0) > 0);
  const nudgeTimeoutCountSum = filtered.reduce(
    (sum, run) => sum + (run.metrics?.nudgeTimeoutCount ?? 0),
    0,
  );
  return {
    schemaVersion: 1,
    criterion: 'nudgeTimeoutCount zero over rolling window',
    recordedAt: new Date().toISOString(),
    runnerFilter,
    windowDays: null,
    windowStart: null,
    windowEnd: new Date().toISOString(),
    totalRunsInWindow: runs.length,
    runnerRunsInWindow: filtered.length,
    nudgeTimeoutCountSum,
    timeoutRunCount: timeoutRuns.length,
    exitPass: nudgeTimeoutCountSum === 0,
    timeoutRuns: timeoutRuns.slice(0, 20).map((run) => ({
      id: run.id,
      slotId: run.slotId,
      updatedAt: run.updatedAt ?? run.createdAt,
      nudgeTimeoutCount: run.metrics?.nudgeTimeoutCount ?? 0,
    })),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.windowDays) || args.windowDays <= 0) {
    console.error('capture-nudge-timeout-window: --window-days must be a positive number');
    process.exit(2);
  }
  const cutoffMs = Date.now() - args.windowDays * 24 * 60 * 60 * 1000;
  const runs = loadRunsInWindow(args.runsDir, cutoffMs);
  const report = summarize(runs, args.runner);
  report.windowDays = args.windowDays;
  report.windowStart = new Date(cutoffMs).toISOString();
  report.runsDir =
    path.relative(ROOT, args.runsDir) === ''
      ? '.'
      : path.relative(ROOT, args.runsDir);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, text);
  else process.stdout.write(text);
  if (!report.exitPass) process.exit(1);
}

main();