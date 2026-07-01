#!/usr/bin/env node
/**
 * Per-runner tmux validation harness (ADR-032).
 *
 * usage:
 *   node scripts/runner-validation/run.mjs [--runner claude|codex|both] [--scenario hook-smoke|all] [--out-dir path] [--timeout-ms 180000] [--keep-session]
 */
import fs from 'node:fs';
import path from 'node:path';

import { EVIDENCE_DIR, sleepMs } from './lib/common.mjs';
import { getRunnerAdapter, resolveRunnerList } from './runners/index.mjs';
import { listScenarios, SCENARIOS } from './scenarios/index.mjs';

function parseArgs(argv) {
  const args = {
    runner: 'both',
    scenario: 'all',
    outDir: EVIDENCE_DIR,
    timeoutMs: 300000,
    keepSession: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--runner') args.runner = argv[++i];
    else if (token === '--scenario') args.scenario = argv[++i];
    else if (token === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (token === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (token === '--keep-session') args.keepSession = true;
    else if (token === '--help' || token === '-h') {
      console.log(
        'usage: runner-validation/run.mjs [--runner claude|codex|cursor|grok|both|hooks|pane-only|all] [--scenario hook-smoke|pane-smoke|interaction-smoke|dispatch-prompt-smoke|dispatch-prompt-mcp-race|prompt-accepted|turn-boundary|busy-composer|mode-switch|session-attribution-smoke|token-usage-smoke|all] [--out-dir path] [--timeout-ms 300000] [--keep-session]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

function runnersForArg(runnerArg) {
  return resolveRunnerList(runnerArg);
}

function scenariosForArg(scenarioArg) {
  if (scenarioArg === 'all') return listScenarios();
  if (!SCENARIOS[scenarioArg]) throw new Error(`unsupported scenario: ${scenarioArg}`);
  return [scenarioArg];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });

  const runners = runnersForArg(args.runner);
  const scenarios = scenariosForArg(args.scenario);
  const results = [];

  for (const runnerId of runners) {
    const runnerAdapter = getRunnerAdapter(runnerId);
    for (const scenarioId of scenarios) {
      sleepMs(3000);
      const scenario = SCENARIOS[scenarioId];
      const result = await scenario.runScenario({
        runnerAdapter,
        timeoutMs: args.timeoutMs,
        keepSession: args.keepSession,
        outDir: args.outDir,
      });
      results.push(result);
      const label = result.skipped ? 'SKIP' : result.pass ? 'PASS' : 'FAIL';
      console.log(`${runnerId}/${scenarioId}: ${label} -> ${result.outPath}`);
      if (!result.pass && !result.skipped) {
        console.error(JSON.stringify(result.report, null, 2));
      }
    }
  }

  const failed = results.filter((entry) => !entry.pass && !entry.skipped);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`[runner-validation] ${error?.message || String(error)}`);
  process.exit(1);
});
