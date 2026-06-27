#!/usr/bin/env node
/**
 * ADR-032 Phase 1 empirical gate helper.
 *
 * Run on a machine with an active Claude slot to capture hook viability signals.
 * Does not mutate runner behavior — installs/reads observability artifacts only.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { slotId: null, repo: null, runtimeDir: '.agent', out: null, runner: 'claude' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--slot-id') args.slotId = argv[++i];
    else if (token === '--repo') args.repo = argv[++i];
    else if (token === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (token === '--runner') args.runner = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--help' || token === '-h') {
      console.log(`usage: probe-runner-observability.mjs --slot-id <id> --repo <path> [--runtime-dir .agent] [--out report.json]`);
      process.exit(0);
    }
  }
  if (!args.slotId || !args.repo) {
    console.error('missing required --slot-id and --repo');
    process.exit(2);
  }
  return args;
}

function benchHookWriter(repo, runtimeDir, slotId, runner = 'claude', iterations = 5) {
  const installer = path.join(ROOT, 'scripts', 'install-runner-observability.mjs');
  const started = Date.now();
  execFileSync(process.execPath, [
    installer,
    '--runner',
    runner,
    '--repo',
    repo,
    '--runtime-dir',
    runtimeDir,
    '--slot-id',
    slotId,
  ]);
  const installMs = Date.now() - started;
  const hookPath = path.join(repo, runtimeDir, '.observability', 'bin', 'farmslot-observability-hook.mjs');
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const payload = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'probe',
      cwd: repo,
    });
    const t0 = Date.now();
    execFileSync(process.execPath, [hookPath], {
      input: payload,
      env: {
        ...process.env,
        FARMSLOT_OBS_DIR: path.join(repo, runtimeDir, '.observability'),
        FARMSLOT_SLOT_ID: slotId,
        FARMSLOT_RUNNER: runner,
        TMUX_PANE: process.env.TMUX_PANE || '%0',
      },
    });
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return { installMs, samples, median };
}

function readHookTail(repo, runtimeDir) {
  const logPath = path.join(repo, runtimeDir, '.observability', 'hooks.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-5)
    .map((line) => JSON.parse(line));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const hostname = os.hostname().replace(/\.local$/, '');
  const bench = benchHookWriter(args.repo, args.runtimeDir, args.slotId, args.runner);
  const tail = readHookTail(args.repo, args.runtimeDir);
  const inTmux = Boolean(process.env.TMUX_PANE);
  const tmuxPaneSeen = tail.some((row) => typeof row.tmuxPane === 'string' && row.tmuxPane.length > 0);
  const runnerSeen = tail.some((row) => row.runner === args.runner);
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    host: hostname,
    runner: args.runner,
    slotId: args.slotId,
    repo: path.resolve(args.repo),
    inTmux,
    tmuxPane: process.env.TMUX_PANE || null,
    tmuxPaneSeenInHooks: tmuxPaneSeen,
    hookLatencyMs: bench,
    gate: {
      installOnly: !inTmux,
      tmuxPaneRequired: inTmux,
      tmuxPanePass: inTmux ? tmuxPaneSeen : null,
      runnerTagPass: runnerSeen,
      latencyMedianPass: bench.median < 150,
      latencyMedianTargetMs: 150,
    },
    notes: [
      'Outside tmux: install + latency only; $TMUX_PANE proof is hook-smoke in scripts/e2e-tmux-runner-validate.sh.',
      'Run separately in plan mode and after a real tool call to validate PostToolUse semantics.',
      'Agreement NDJSON is optional fleet telemetry — not a Phase 1 closeout gate.',
    ],
    recentHookEvents: tail,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, text);
  else process.stdout.write(text);
  const tmuxPaneFailed = inTmux && !tmuxPaneSeen;
  if (tmuxPaneFailed || !report.gate.runnerTagPass || !report.gate.latencyMedianPass) {
    process.exit(1);
  }
}

main();
