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

function parseArgs(argv) {
  const args = { slotId: null, repo: null, runtimeDir: '.agent', out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--slot-id') args.slotId = argv[++i];
    else if (token === '--repo') args.repo = argv[++i];
    else if (token === '--runtime-dir') args.runtimeDir = argv[++i];
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

function benchHookWriter(repo, runtimeDir, slotId, iterations = 5) {
  const installer = path.resolve('scripts/install-runner-observability.mjs');
  const started = Date.now();
  execFileSync(process.execPath, [
    installer,
    '--runner',
    'claude',
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
        TMUX_PANE: process.env.TMUX_PANE || '%0',
      },
    });
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return { installMs, samples, median };
}

function readHookTail(repo) {
  const logPath = path.join(repo, '.observability', 'hooks.jsonl');
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
  const bench = benchHookWriter(args.repo, args.runtimeDir, args.slotId);
  const tail = readHookTail(args.repo);
  const tmuxPaneSeen = tail.some((row) => typeof row.tmuxPane === 'string' && row.tmuxPane.length > 0);
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    host: hostname,
    slotId: args.slotId,
    repo: path.resolve(args.repo),
    tmuxPane: process.env.TMUX_PANE || null,
    tmuxPaneSeenInHooks: tmuxPaneSeen,
    hookLatencyMs: bench,
    gate: {
      tmuxPaneRequired: true,
      tmuxPanePass: tmuxPaneSeen,
      latencyMedianPass: bench.median < 150,
      latencyMedianTargetMs: 150,
    },
    notes: [
      'Run separately in plan mode and after a real tool call to validate PostToolUse semantics.',
      'Compare hook-vs-pane agreement via gateway .runs/observability-agreement/*.ndjson after live nudges.',
    ],
    recentHookEvents: tail,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, text);
  else process.stdout.write(text);
  if (!report.gate.tmuxPanePass || !report.gate.latencyMedianPass) process.exit(1);
}

main();