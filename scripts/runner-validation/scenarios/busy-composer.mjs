import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeEvidence } from '../lib/evidence.mjs';
import { paneShowsBusyComposer } from '../lib/pane-patterns.mjs';

export const SCENARIO_ID = 'busy-composer';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/panes');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

export async function runScenario({ runnerAdapter, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const skip = runnerAdapter.skipReason(SCENARIO_ID);
  const report = {
    runner,
    mode: 'fixture',
    fixtures: [],
    pass: false,
    skipped: Boolean(skip),
    skipReason: skip,
    error: null,
  };

  if (skip) {
    report.pass = true;
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  if (runner !== 'claude') {
    report.error = `busy-composer fixtures are claude-specific; got ${runner}`;
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: false, report };
  }

  try {
    const cases = [
      { file: 'claude-composing.txt', expectBusy: true },
      { file: 'claude-idle.txt', expectBusy: false },
    ];
    for (const testCase of cases) {
      const pane = readFixture(testCase.file);
      const busy = paneShowsBusyComposer(pane);
      report.fixtures.push({ file: testCase.file, busy, expectBusy: testCase.expectBusy, pass: busy === testCase.expectBusy });
    }
    report.pass = report.fixtures.every((entry) => entry.pass);
  } catch (error) {
    report.error = error?.message || String(error);
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}