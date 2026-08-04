#!/usr/bin/env node
/**
 * ADR-032 Phase 1 local E2E harness.
 *
 * Automates tmux + hook + gateway checks that probe-runner-observability.mjs does not cover:
 * runtime-dir alignment, sentinel digest correlation, agreement log, and optional gateway send.
 *
 * Usage:
 *   node scripts/e2e-runner-observability.mjs \
 *     --slot-id demo-work-1 \
 *     --repo /path/to/repo \
 *     --project farmslot \
 *     --out /tmp/obs-e2e.json
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    slotId: null,
    repo: process.cwd(),
    project: null,
    runtimeDir: null,
    tmuxSession: null,
    tmuxTarget: null,
    out: null,
    keepSession: false,
    skipGateway: false,
    skipClaude: false,
    agreementDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--slot-id') args.slotId = argv[++i];
    else if (token === '--repo') args.repo = path.resolve(argv[++i]);
    else if (token === '--project') args.project = argv[++i];
    else if (token === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (token === '--tmux-session') args.tmuxSession = argv[++i];
    else if (token === '--tmux-target') args.tmuxTarget = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--agreement-dir') args.agreementDir = argv[++i];
    else if (token === '--keep-session') args.keepSession = true;
    else if (token === '--skip-gateway') args.skipGateway = true;
    else if (token === '--skip-claude') args.skipClaude = true;
    else if (token === '--help' || token === '-h') {
      console.log(`usage: e2e-runner-observability.mjs --slot-id <id> [--repo <path>] [--project <name>] \\
  [--runtime-dir <rel>] [--tmux-session <name>] [--tmux-target <session:window>] \\
  [--agreement-dir <path>] [--out report.json] [--keep-session] [--skip-gateway] [--skip-claude]`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (!args.slotId) throw new Error('missing required --slot-id');
  args.tmuxSession ??= `obs-e2e-${args.slotId}`;
  args.tmuxTarget ??= `${args.tmuxSession}:shell`;
  return args;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function tmux(args, opts = {}) {
  return execFileSync('tmux', args, { encoding: 'utf8', ...opts }).trim();
}

function hasTmuxSession(name) {
  try {
    tmux(['has-session', '-t', name]);
    return true;
  } catch {
    // tmux has-session exits non-zero when the session does not exist
    return false;
  }
}

function killTmuxSession(name) {
  if (!hasTmuxSession(name)) return;
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  } catch {
    // session may have exited between has-session and kill
  }
}

function ensureTmuxShellSession(sessionName, repo, windowName = 'shell') {
  if (!hasTmuxSession(sessionName)) {
    tmux(['new-session', '-d', '-s', sessionName, '-n', windowName, '-c', repo]);
  } else if (
    !tmux(['list-windows', '-t', sessionName, '-F', '#{window_name}'])
      .split('\n')
      .includes(windowName)
  ) {
    tmux(['new-window', '-t', sessionName, '-n', windowName, '-c', repo]);
  }
  const paneId = tmux([
    'display-message',
    '-p',
    '-t',
    `${sessionName}:${windowName}`,
    '#{pane_id}',
  ]);
  return { sessionName, windowName, paneId, target: `${sessionName}:${windowName}` };
}

function runInTmuxPane(paneId, command) {
  tmux(['send-keys', '-t', paneId, command, 'C-m']);
}

function sleepMs(ms) {
  execFileSync('sleep', [String(Math.max(0.1, ms / 1000))]);
}

function waitForTmuxMarker(paneId, marker, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = tmux(['capture-pane', '-p', '-t', paneId, '-S', '-40']);
    if (pane.includes(marker)) return pane;
    sleepMs(500);
  }
  return tmux(['capture-pane', '-p', '-t', paneId, '-S', '-40']);
}

function readProjectRuntimeDir(projectName) {
  const projectPath = path.join(ROOT, 'projects', projectName, 'project.json');
  if (!fs.existsSync(projectPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  return parsed?.paths?.runtime_dir ?? null;
}

function obsDirFor(repo, runtimeDir) {
  return path.resolve(repo, runtimeDir, '.observability');
}

function readObsDirFromSettings(repo, runtimeDir) {
  const settingsPath = path.join(repo, runtimeDir, '.observability', 'claude-settings.json');
  if (!fs.existsSync(settingsPath)) return null;
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(hooks)) return null;
  for (const entry of hooks) {
    for (const hook of entry?.hooks ?? []) {
      const command = hook?.command;
      if (typeof command !== 'string' || !command.includes('FARMSLOT_OBS_DIR=')) continue;
      const match = command.match(/FARMSLOT_OBS_DIR='([^']+)'/);
      if (match) return match[1];
    }
  }
  return null;
}

let instructionNeedle;
let runnerPromptDigest;

async function loadPromptDigestModule() {
  const { register } = await import('tsx/esm/api');
  register();
  const mod = await import(
    pathToFileURL(path.join(ROOT, 'services/gateway/src/runners/observability-prompt-digest.ts'))
      .href
  );
  instructionNeedle = mod.instructionNeedle;
  runnerPromptDigest = mod.runnerPromptDigest;
}

function refreshCompatObservabilityLink(repo, runtimeDir) {
  const compatLink = path.join(repo, '.observability');
  const target = obsDirFor(repo, runtimeDir);
  try {
    if (fs.existsSync(compatLink)) {
      const stat = fs.lstatSync(compatLink);
      if (stat.isSymbolicLink()) fs.unlinkSync(compatLink);
    }
  } catch {
    // ignore — installer will create or replace as needed
  }
  if (!fs.existsSync(compatLink)) fs.symlinkSync(target, compatLink, 'dir');
}

function readProbeReport(outPath, attempts = 10) {
  for (let i = 0; i < attempts; i += 1) {
    if (fs.existsSync(outPath)) {
      return JSON.parse(fs.readFileSync(outPath, 'utf8'));
    }
    sleepMs(200);
  }
  return null;
}

function installObservability(repo, runtimeDir, slotId) {
  refreshCompatObservabilityLink(repo, runtimeDir);
  const installer = path.join(ROOT, 'scripts', 'install-runner-observability.mjs');
  execFileSync(
    process.execPath,
    [
      installer,
      '--runner',
      'claude',
      '--repo',
      repo,
      '--runtime-dir',
      runtimeDir,
      '--slot-id',
      slotId,
    ],
    { stdio: 'pipe' },
  );
}

function runProbeInTmux(repo, runtimeDir, slotId, paneId) {
  const out = path.join(os.tmpdir(), `obs-probe-${slotId}-${process.pid}.json`);
  const runner = path.join(os.tmpdir(), `run-obs-probe-${process.pid}.sh`);
  fs.writeFileSync(
    runner,
    `#!/bin/bash
set -euo pipefail
cd ${shQuote(repo)}
node ${shQuote(path.join(ROOT, 'scripts', 'probe-runner-observability.mjs'))} \\
  --slot-id ${shQuote(slotId)} \\
  --repo ${shQuote(repo)} \\
  --runtime-dir ${shQuote(runtimeDir)} \\
  --out ${shQuote(out)}
echo __PROBE_EXIT__=$?
`,
    { mode: 0o755 },
  );
  runInTmuxPane(paneId, `bash ${shQuote(runner)}`);
  waitForTmuxMarker(paneId, '__PROBE_EXIT__=', 90000);
  const report = readProbeReport(out, 30);
  const exitCode =
    report?.gate?.tmuxPanePass === true && report?.gate?.latencyMedianPass === true ? 0 : 1;
  return { exitCode, report, out, runner };
}

function testSentinelCorrelation(obsDir, paneId, message) {
  const digest = runnerPromptDigest(message);
  const sentDir = path.join(obsDir, 'sent');
  fs.mkdirSync(sentDir, { recursive: true });
  const sentAt = Date.now();
  fs.writeFileSync(
    path.join(sentDir, `${digest}.json`),
    `${JSON.stringify({ sentAt, digest, prompt: instructionNeedle(message) })}\n`,
  );
  const hookPath = path.join(obsDir, 'bin', 'farmslot-observability-hook.mjs');
  const payload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'e2e',
    cwd: process.cwd(),
    prompt: message,
  });
  execFileSync(process.execPath, [hookPath], {
    input: payload,
    env: {
      ...process.env,
      FARMSLOT_OBS_DIR: obsDir,
      FARMSLOT_SLOT_ID: 'e2e',
      TMUX_PANE: paneId,
    },
  });
  const tail = fs.readFileSync(path.join(obsDir, 'hooks.jsonl'), 'utf8').trim().split('\n').pop();
  const row = JSON.parse(tail);
  return {
    digest,
    hookDigest: row.runnerPromptDigest ?? null,
    pass: row.runnerPromptDigest === digest,
  };
}

function runAgreementLogCheck(agreementDir) {
  const snippet = `
import { appendRunnerObservabilityAgreement, readAgreementEntriesSince, aggregateAgreementEntries } from './services/gateway/src/runners/observability-agreement-log.ts';
const since = Date.now();
await appendRunnerObservabilityAgreement({ slotId: 'e2e', runner: 'claude', target: 'e2e:0', logPrefix: 'e2e', paneBusy: false, hookBusy: false, agreed: true, timestamp: since });
const entries = await readAgreementEntriesSince(since - 1000);
const agg = aggregateAgreementEntries(entries);
const pass = entries.length === 1 && agg.agreed === 1;
console.log(JSON.stringify({ pass, entries: entries.length, agg }));
process.exit(pass ? 0 : 1);
`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FARMSLOT_OBSERVABILITY_AGREEMENT_DIR: agreementDir },
  });
  if (result.status !== 0) {
    return { pass: false, error: result.stderr || result.stdout || 'agreement log check failed' };
  }
  return { pass: true, ...JSON.parse(result.stdout.trim().split('\n').pop()) };
}

function runGatewaySendCheck(slotId, tmuxTarget, agreementDir, message) {
  const snippet = `
import { loadSlotVars } from './services/gateway/src/core/config.ts';
import { sendRunnerInstructionSafely } from './services/gateway/src/runners/registry.ts';
import { readAgreementEntriesSince, aggregateAgreementEntries } from './services/gateway/src/runners/observability-agreement-log.ts';
import { resolveProjectRuntimeDir } from './services/gateway/src/core/config.ts';
import { runnerPromptDigest } from './services/gateway/src/runners/observability-prompt-digest.ts';
import fs from 'node:fs';
import path from 'node:path';

const slotId = ${JSON.stringify(slotId)};
const target = ${JSON.stringify(tmuxTarget)};
const message = ${JSON.stringify(message)};
const since = Date.now();
const vars = await loadSlotVars(slotId);
const digest = runnerPromptDigest(message);
const runtimeDir = await resolveProjectRuntimeDir(vars.projectName);
const repo = vars.remoteRepo;
const sentinelPath = path.resolve(repo, runtimeDir, '.observability', 'sent', digest + '.json');
const ok = await sendRunnerInstructionSafely(vars, target, 'claude', message, '[e2e]', 25000);
const entries = await readAgreementEntriesSince(since - 5000);
const agg = aggregateAgreementEntries(entries);
const sentinelExists = fs.existsSync(sentinelPath);
const result = { ok, sentinelExists, sentinelPath, digest, agreementEntries: entries.length, agreement: agg };
console.log(JSON.stringify(result));
process.exit(ok && sentinelExists ? 0 : 1);
`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FARMSLOT_OBSERVABILITY_AGREEMENT_DIR: agreementDir },
  });
  const stdout = result.stdout?.trim() ?? '';
  const jsonLine = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .pop();
  if (!jsonLine) {
    return {
      pass: false,
      error: result.stderr || stdout || 'gateway send check failed',
    };
  }
  const detail = JSON.parse(jsonLine);
  return {
    pass: result.status === 0,
    degradedWarning: (result.stderr || '').includes('[observability] degraded'),
    ...detail,
  };
}

function ensureInteractiveClaude(target, paneId, settingsPath) {
  const pane = tmux(['capture-pane', '-p', '-t', paneId, '-S', '-20']);
  if (pane.includes('bypass permissions on') || pane.includes('Claude Code')) return pane;
  runInTmuxPane(
    paneId,
    `claude --dangerously-skip-permissions --settings ${shQuote(settingsPath)}`,
  );
  return waitForTmuxMarker(paneId, 'bypass permissions on', 45000);
}

function checkRuntimeAlignment(repo, runtimeDir, projectRuntimeDir) {
  const installObsDir = obsDirFor(repo, runtimeDir);
  const projectObsDir = projectRuntimeDir ? obsDirFor(repo, projectRuntimeDir) : installObsDir;
  const settingsObsDir = readObsDirFromSettings(repo, projectRuntimeDir ?? runtimeDir);
  const aligned =
    path.resolve(installObsDir) === path.resolve(projectObsDir) &&
    (!settingsObsDir || path.resolve(settingsObsDir) === path.resolve(installObsDir));
  return {
    pass: aligned,
    installObsDir,
    projectObsDir,
    settingsObsDir,
    runtimeDir,
    projectRuntimeDir,
  };
}

async function main() {
  let args;
  try {
    await loadPromptDigestModule();
    args = parseArgs(process.argv.slice(2));
    const projectRuntimeDir = args.project ? readProjectRuntimeDir(args.project) : null;
    const runtimeDir = args.runtimeDir ?? projectRuntimeDir ?? '.agent';
    const agreementDir =
      args.agreementDir ?? path.join(os.tmpdir(), `farmslot-obs-agreement-e2e-${process.pid}`);
    const hostname = os.hostname().replace(/\.local$/, '');
    const obsDir = obsDirFor(args.repo, runtimeDir);

    const shell = ensureTmuxShellSession(args.tmuxSession, args.repo, 'shell');
    const claude = ensureTmuxShellSession(args.tmuxSession, args.repo, 'claude');
    const checks = {};
    installObservability(args.repo, runtimeDir, args.slotId);
    checks.runtimeAlignment = checkRuntimeAlignment(args.repo, runtimeDir, projectRuntimeDir);
    checks.probeGate = runProbeInTmux(args.repo, runtimeDir, args.slotId, shell.paneId);
    checks.sentinelCorrelation = testSentinelCorrelation(
      obsDir,
      shell.paneId,
      `OBS_E2E_SENTINEL_${args.slotId}`,
    );

    fs.mkdirSync(agreementDir, { recursive: true });
    checks.agreementLog = runAgreementLogCheck(agreementDir);

    if (!args.skipGateway && !args.skipClaude) {
      ensureInteractiveClaude(
        claude.target,
        claude.paneId,
        path.join(obsDir, 'claude-settings.json'),
      );
      const gatewayMessage = `OBS_GATEWAY_E2E_${args.slotId}: reply with exactly GATEWAY_OK`;
      checks.gatewaySend = runGatewaySendCheck(
        args.slotId,
        claude.target,
        agreementDir,
        gatewayMessage,
      );
      const paneTail = tmux(['capture-pane', '-p', '-t', claude.paneId, '-S', '-20']);
      checks.gatewaySend.paneShowsOk = paneTail.includes('GATEWAY_OK');
      checks.gatewaySend.hookAgreed = (checks.gatewaySend.agreement?.agreed ?? 0) >= 1;
      checks.gatewaySend.pass =
        checks.gatewaySend.ok === true &&
        checks.gatewaySend.sentinelExists === true &&
        checks.gatewaySend.paneShowsOk === true;
    } else {
      checks.gatewaySend = { pass: true, skipped: true };
    }

    const probePass =
      checks.probeGate.exitCode === 0 ||
      (checks.probeGate.report?.gate?.tmuxPanePass === true &&
        checks.probeGate.report?.gate?.latencyMedianPass === true);
    checks.probeGate.pass = probePass;

    const pass =
      checks.runtimeAlignment.pass &&
      probePass &&
      checks.sentinelCorrelation.pass &&
      checks.agreementLog.pass &&
      checks.gatewaySend.pass;

    const report = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      host: hostname,
      slotId: args.slotId,
      repo: args.repo,
      runtimeDir,
      projectRuntimeDir,
      obsDir,
      tmux: { shell: shell.target, claude: claude.target },
      pass,
      checks,
    };

    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out) fs.writeFileSync(args.out, text);
    else process.stdout.write(text);

    if (!args.keepSession) killTmuxSession(args.tmuxSession);

    if (!pass) process.exit(1);
  } catch (error) {
    console.error(`[e2e-runner-observability] ${error?.message || String(error)}`);
    if (args && !args.keepSession) killTmuxSession(args.tmuxSession);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[e2e-runner-observability] ${error?.message || String(error)}`);
  process.exit(1);
});
