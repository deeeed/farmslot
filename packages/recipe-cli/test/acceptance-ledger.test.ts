// The acceptance ledger a run writes from its recipe's proof targets, through the
// same ledger code `farmslot-agent ac` uses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  acceptanceIdForProofTarget,
  recordRecipeAcceptance,
} from '../src/harness/acceptance-ledger.js';

const require = createRequire(import.meta.url);
const shared = require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as {
  setAcceptanceVerdict(taskDir: string, input: Record<string, unknown>): unknown;
  validateAcceptanceStatusLedger(value: unknown): string[];
};

const CRITERIA = ['no discount', 'rewards discount', 'subscription waiver', 'twap', 'changelog'];

// A checkout with a task dir: the handoff's criteria, the executed recipe and its
// trace, as a run with RECIPE_TASK_DIR leaves them.
function taskRun(options: {
  criteria?: string[];
  /** Proof target ids; each becomes a `{ id, claim }` target. */
  proofTargets: string[];
  nodes: Record<string, string[]>;
  trace: Array<{ nodeId: string; ok: boolean; artifacts?: Array<{ path: string }> }>;
  /** Write the trace as a bare array of entries, the other shape the protocol allows. */
  bareTrace?: boolean;
}): { target: string; taskDir: string; result: { recipePath: string; tracePath: string } } {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-acceptance-'));
  const taskDir = path.join(target, 'temp', 'tasks', 'feat', 'tat-1');
  const artifacts = path.join(taskDir, 'artifacts');
  fs.mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(artifacts, 'live'), { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'inputs', 'handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: options.criteria ?? CRITERIA } }),
  );
  const nodes = Object.fromEntries(
    Object.entries(options.nodes).map(([id, proves]) => [id, { action: 'assert_json', proves }]),
  );
  const recipePath = path.join(artifacts, 'recipe.json');
  const tracePath = path.join(artifacts, 'trace.json');
  fs.writeFileSync(
    recipePath,
    JSON.stringify({
      proofTargets: options.proofTargets.map((id) => ({ id, claim: `claim ${id}` })),
      workflow: { nodes },
    }),
  );
  fs.writeFileSync(
    tracePath,
    JSON.stringify(options.bareTrace ? options.trace : { entries: options.trace }),
  );
  return { target, taskDir, result: { recipePath, tracePath } };
}

function readLedger(taskDir: string): { criteria: Array<Record<string, unknown>> } {
  return JSON.parse(
    fs.readFileSync(path.join(taskDir, 'artifacts', 'acceptance-status.json'), 'utf8'),
  );
}

describe('recipe acceptance ledger', () => {
  test('maps AC1 and AC-1 to the handoff id, and nothing else', () => {
    assert.equal(acceptanceIdForProofTarget('AC1'), 'AC-1');
    assert.equal(acceptanceIdForProofTarget('ac-12'), 'AC-12');
    assert.equal(acceptanceIdForProofTarget('P1'), null);
    assert.equal(acceptanceIdForProofTarget('AC0'), null);
  });

  test('proven when every proving node passed, missing when one failed or did not run, else unrecorded', () => {
    const run = taskRun({
      proofTargets: ['AC1', 'AC2', 'AC3', 'AC4'],
      nodes: {
        'assert-default': ['AC1'],
        'assert-unit-default': ['AC1'],
        'assert-rewards': ['AC2'],
        'assert-waiver': ['AC3'],
        setup: [],
      },
      trace: [
        { nodeId: 'setup', ok: true },
        { nodeId: 'assert-default', ok: true },
        { nodeId: 'assert-unit-default', ok: true },
        { nodeId: 'assert-rewards', ok: false },
      ],
    });
    const { recorded, refused } = recordRecipeAcceptance(run.taskDir, run.target, run.result);
    assert.deepEqual(refused, []);
    assert.deepEqual(
      recorded.map(({ id, verdict, recipeNodes }) => ({ id, verdict, recipeNodes })),
      [
        { id: 'AC-1', verdict: 'proven', recipeNodes: ['assert-default', 'assert-unit-default'] },
        { id: 'AC-2', verdict: 'missing', recipeNodes: ['assert-rewards'] },
        { id: 'AC-3', verdict: 'missing', recipeNodes: ['assert-waiver'] },
      ],
    );
    const ledger = readLedger(run.taskDir);
    assert.deepEqual(shared.validateAcceptanceStatusLedger(ledger), []);
    // AC4 has no proving node and AC5 no target: the run says nothing about them.
    assert.deepEqual(
      ledger.criteria.map((entry) => [entry.id, entry.text, entry.verdict]),
      [
        ['AC-1', 'no discount', 'proven'],
        ['AC-2', 'rewards discount', 'missing'],
        ['AC-3', 'subscription waiver', 'missing'],
      ],
    );
  });

  test("evidence is the trace plus the proving nodes' artifacts inside the task dir", () => {
    const run = taskRun({
      proofTargets: ['AC1'],
      nodes: { 'read-quote': ['AC1'] },
      trace: [
        {
          nodeId: 'read-quote',
          ok: true,
          artifacts: [
            { path: 'live/quote.json' },
            { path: 'temp/tasks/feat/tat-1/artifacts/live/account.json' },
            { path: 'outside.json' },
          ],
        },
      ],
    });
    const artifacts = path.dirname(run.result.tracePath);
    fs.writeFileSync(path.join(artifacts, 'live', 'quote.json'), '{}');
    fs.writeFileSync(path.join(artifacts, 'live', 'account.json'), '{}');
    fs.writeFileSync(path.join(run.target, 'outside.json'), '{}');
    recordRecipeAcceptance(run.taskDir, run.target, run.result);
    assert.deepEqual(readLedger(run.taskDir).criteria[0]!.evidence, [
      'artifacts/trace.json',
      'artifacts/live/quote.json',
      'artifacts/live/account.json',
    ]);
  });

  test('refuses a target the handoff does not list and records the rest', () => {
    const run = taskRun({
      criteria: ['only one'],
      proofTargets: ['AC1', 'AC2'],
      nodes: { a: ['AC1'], b: ['AC2'] },
      trace: [
        { nodeId: 'a', ok: true },
        { nodeId: 'b', ok: true },
      ],
    });
    const { recorded, refused } = recordRecipeAcceptance(run.taskDir, run.target, run.result);
    assert.deepEqual(
      recorded.map((entry) => entry.id),
      ['AC-1'],
    );
    assert.equal(refused.length, 1);
    assert.match(refused[0]!, /^AC-2: unknown acceptance criterion AC-2/u);
  });

  test('writes nothing when the handoff lists no criteria', () => {
    const run = taskRun({
      criteria: [],
      proofTargets: ['AC1'],
      nodes: { a: ['AC1'] },
      trace: [{ nodeId: 'a', ok: true }],
    });
    assert.deepEqual(recordRecipeAcceptance(run.taskDir, run.target, run.result), {
      recorded: [],
      refused: [],
    });
    assert.equal(
      fs.existsSync(path.join(run.taskDir, 'artifacts', 'acceptance-status.json')),
      false,
    );
  });

  test('shares one file with `farmslot-agent ac`: a manual verdict and the run merge', () => {
    const run = taskRun({
      proofTargets: ['AC1'],
      nodes: { a: ['AC1'] },
      trace: [{ nodeId: 'a', ok: true }],
    });
    shared.setAcceptanceVerdict(run.taskDir, {
      id: 'AC-5',
      verdict: 'untestable',
      evidence: [],
      recipeNodes: [],
      note: 'CHANGELOG only',
    });
    recordRecipeAcceptance(run.taskDir, run.target, run.result);
    assert.deepEqual(
      readLedger(run.taskDir).criteria.map((entry) => [entry.id, entry.verdict]),
      [
        ['AC-1', 'proven'],
        ['AC-5', 'untestable'],
      ],
    );
  });

  test('AC1 and AC-1 are one criterion: every node proving either must pass', () => {
    const run = taskRun({
      proofTargets: ['AC1', 'AC-1'],
      nodes: { a: ['AC1'], b: ['AC-1'] },
      trace: [
        { nodeId: 'a', ok: true },
        { nodeId: 'b', ok: false },
      ],
    });
    const { recorded } = recordRecipeAcceptance(run.taskDir, run.target, run.result);
    assert.deepEqual(recorded, [
      {
        id: 'AC-1',
        verdict: 'missing',
        recipeNodes: ['a', 'b'],
        evidence: ['artifacts/trace.json'],
      },
    ]);
  });

  test('reads a bare-array trace, and a retried node counts by its last entry', () => {
    const run = taskRun({
      proofTargets: ['AC1'],
      nodes: { a: ['AC1'] },
      trace: [
        { nodeId: 'a', ok: false },
        { nodeId: 'a', ok: true },
      ],
      bareTrace: true,
    });
    recordRecipeAcceptance(run.taskDir, run.target, run.result);
    assert.equal(readLedger(run.taskDir).criteria[0]!.verdict, 'proven');
  });

  test('keeps no evidence a symlink brings in from outside the task dir', () => {
    const run = taskRun({
      proofTargets: ['AC1'],
      nodes: { a: ['AC1'] },
      trace: [
        {
          nodeId: 'a',
          ok: true,
          artifacts: [{ path: 'linked.json' }, { path: '..cache/in.json' }],
        },
      ],
    });
    const artifacts = path.dirname(run.result.tracePath);
    fs.writeFileSync(path.join(run.target, 'outside.json'), '{}');
    fs.symlinkSync(path.join(run.target, 'outside.json'), path.join(artifacts, 'linked.json'));
    fs.mkdirSync(path.join(artifacts, '..cache'));
    fs.writeFileSync(path.join(artifacts, '..cache', 'in.json'), '{}');
    recordRecipeAcceptance(run.taskDir, run.target, run.result);
    assert.deepEqual(readLedger(run.taskDir).criteria[0]!.evidence, [
      'artifacts/trace.json',
      'artifacts/..cache/in.json',
    ]);
  });

  test('a run replaces the verdict of the ids it proves, including a manual one, and keeps the rest', () => {
    const run = taskRun({
      proofTargets: ['AC1'],
      nodes: { a: ['AC1'] },
      trace: [{ nodeId: 'a', ok: true }],
    });
    for (const id of ['AC-1', 'AC-2']) {
      shared.setAcceptanceVerdict(run.taskDir, {
        id,
        verdict: 'untestable',
        evidence: [],
        recipeNodes: [],
        note: 'manual',
      });
    }
    recordRecipeAcceptance(run.taskDir, run.target, run.result);
    assert.deepEqual(
      readLedger(run.taskDir).criteria.map((entry) => [entry.id, entry.verdict]),
      [
        ['AC-1', 'proven'],
        ['AC-2', 'untestable'],
      ],
    );
  });
});
