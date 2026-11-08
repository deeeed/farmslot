const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveWorkerTerminalContract } = require('../scripts/worker-terminal-contract.cjs');
const { engineClaims } = require('./acceptance-fixtures.cjs');

const { terminalContractInputForChecklist } = require('../scripts/checklist-target.cjs');
const { openSubtaskUnits } = require('../scripts/subtask-unit.cjs');

const marker = path.resolve(__dirname, '../scripts/mark-checklist-step.cjs');
for (const verdict of [undefined, 'failed'])
  test(`proof mark complete records a ${verdict ?? 'missing'} measurement without inventing a passing AC`, (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'proof-terminal-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, 'inputs'));
    mkdirSync(path.join(dir, 'artifacts'));
    writeFileSync(
      path.join(dir, 'checklist-target.json'),
      JSON.stringify({ checklist: 'CHECKLIST.md' }),
    );
    writeFileSync(
      path.join(dir, 'CHECKLIST.md'),
      '# Worker: QA\n\n- [x] Record the observed outcome\n',
    );
    writeFileSync(
      path.join(dir, 'inputs/handoff.json'),
      JSON.stringify({ flow: 'qa', task: { acceptanceCriteria: ['Observe supplied behavior'] } }),
    );
    writeFileSync(path.join(dir, 'artifacts/report.html'), '<p>Recorded measurement</p>');
    writeFileSync(path.join(dir, 'artifacts/learnings.md'), '- Recorded the actual outcome.');
    if (verdict)
      writeFileSync(
        path.join(dir, 'artifacts/acceptance-status.json'),
        JSON.stringify(engineClaims(['Observe supplied behavior'], [verdict])),
      );
    const contract = path.join(dir, 'inputs/worker-terminal-contract.json');
    writeFileSync(contract, JSON.stringify(resolveWorkerTerminalContract(null, 'qa')));
    let result = spawnSync(process.execPath, [marker, dir, 'complete'], { encoding: 'utf8' });
    assert.equal(result.status, 1, 'Ordinary QA still requires acceptance');
    writeFileSync(
      path.join(dir, 'CHECKLIST.md'),
      '# Worker: QA\n\n- [x] Record the outcome\n- [ ] Inspect the case\n',
    );
    writeFileSync(path.join(dir, 'skill.md'), '# Inspect\n\n- [ ] Inspect the case\n');
    result = spawnSync(process.execPath, [marker, dir, 'start'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(
      process.execPath,
      [marker, dir, 'sub', 'start', 'pending-proof', '--step', '2', '--from', 'skill.md'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(
      contract,
      JSON.stringify(resolveWorkerTerminalContract(null, 'qa', { proofMeasurement: true })),
    );
    result = spawnSync(process.execPath, [marker, dir, 'complete'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'))).status, 'complete');
    assert.equal(openSubtaskUnits(dir).length, 1, 'The unfinished worker child stays recorded');
    if (verdict)
      assert.equal(
        JSON.parse(readFileSync(path.join(dir, 'artifacts/acceptance-status.json'))).criteria[0]
          .verdict,
        verdict,
      );
    writeFileSync(path.join(dir, 'REVIEW.md'), '# Review\n\n- [x] Read the recorded proof\n');
    writeFileSync(
      path.join(dir, 'artifacts/review-feedback.md'),
      'Recorded proof has missing or failed coverage.',
    );
    writeFileSync(
      path.join(dir, terminalContractInputForChecklist('REVIEW.md')),
      JSON.stringify(resolveWorkerTerminalContract(null, 'review')),
    );
    result = spawnSync(process.execPath, [marker, dir, '--checklist', 'REVIEW.md', 'complete'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(openSubtaskUnits(dir).length, 1, 'The judge does not complete the worker child');
    writeFileSync(contract, '{broken');
    result = spawnSync(process.execPath, [marker, dir, 'complete'], { encoding: 'utf8' });
    assert.equal(result.status, 1, 'Malformed frozen contracts still refuse');
  });
