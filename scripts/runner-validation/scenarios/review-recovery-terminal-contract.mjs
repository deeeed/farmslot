import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'review-recovery-terminal-contract';
const BASELINE_SHA = '2f5299c7d4c1ed675875d7107d15d1f71970547d';

function runContractExecutor({ root, sourceRoot, sourceSha, resultPath }) {
  const executor = path.join(
    root,
    'scripts/runner-validation/gateway/review-recovery-terminal-contract.mts',
  );
  const stdout = execFileSync('yarn', ['exec', 'tsx', executor], {
    cwd: root,
    env: {
      ...process.env,
      FARMSLOT_VALIDATION_SOURCE_ROOT: sourceRoot,
      FARMSLOT_VALIDATION_SOURCE_SHA: sourceSha,
      FARMSLOT_VALIDATION_RESULT_PATH: resultPath,
    },
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    result: JSON.parse(fs.readFileSync(resultPath, 'utf-8')),
    log: stdout.trim().split('\n').slice(-30),
  };
}

export async function runScenario({ runnerAdapter, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const root = process.cwd();
  fs.mkdirSync(path.join(root, 'temp'), { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(root, 'temp', 'review-recovery-contract-'));
  const baselineRoot = path.join(tempRoot, 'baseline');
  const baselineResultPath = path.join(tempRoot, 'baseline-result.json');
  const currentResultPath = path.join(tempRoot, 'current-result.json');
  const report = {
    runner,
    baselineSha: BASELINE_SHA,
    baseline: null,
    current: null,
    baselineLog: [],
    currentLog: [],
    failBefore: false,
    passAfter: false,
    pass: false,
    error: null,
  };

  try {
    fs.mkdirSync(baselineRoot, { recursive: true });
    const archive = execFileSync('git', ['archive', BASELINE_SHA], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', baselineRoot], {
      input: archive,
      maxBuffer: 256 * 1024 * 1024,
    });
    const baseline = runContractExecutor({
      root,
      sourceRoot: baselineRoot,
      sourceSha: BASELINE_SHA,
      resultPath: baselineResultPath,
    });
    const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
    const current = runContractExecutor({
      root,
      sourceRoot: root,
      sourceSha: `working-tree@${currentSha}`,
      resultPath: currentResultPath,
    });
    report.baseline = baseline.result;
    report.current = current.result;
    report.baselineLog = baseline.log;
    report.currentLog = current.log;
    report.failBefore = baseline.result.contractSatisfied === false;
    report.passAfter = current.result.contractSatisfied === true;
    report.pass = report.failBefore && report.passAfter;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
