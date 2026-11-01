import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  digestRecipeDocument,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
} from '@farmslot/protocol';

import {
  executedProofIndex,
  potentiallyEligibleProof,
  type ProofNode,
} from '../src/evidence/assertions.js';
import { deriveRecipeClaims, type DeriveRecipeClaimsInput } from '../src/evidence/claims.js';
import {
  deriveReviewedRecipeClaims,
  validateRecordedEvidencePackage,
} from '../src/evidence/package.js';
import { assertVisualClaimsObserveUi, planRecipeEvidence } from '../src/evidence/plan.js';

const nodes = new Map<string, ProofNode>([
  ['read', { action: 'state_read' }],
  [
    'assert',
    {
      action: 'assert_output',
      source: 'read',
      assert: { path: '$.count', operator: 'eq', value: 1 },
      proves: ['AC1'],
    },
  ],
]);
const base: DeriveRecipeClaimsInput = {
  recipeRunId: 'attempt-a',
  declarations: [{ id: 'AC1', claim: 'The counter is one.', proofMode: 'state' }],
  nodes,
  trace: [
    { nodeId: 'read', action: 'state_read', ok: true, output: { count: 1 } },
    { nodeId: 'assert', action: 'assert_output', ok: true, output: { matched: true } },
  ],
  artifacts: [],
  segments: [],
};

test('review projection uses the same reducer, preserves bytes and refuses invalid engine inputs', () => {
  const { input } = JSON.parse(
    readFileSync(new URL('./fixtures/visual-review-package.json', import.meta.url), 'utf8'),
  ) as { input: RecordedEvidencePackageInput };
  const before = JSON.stringify(input);
  const claim = input.claims!.criteria.find(({ id }) => id === 'check-1')!;
  const closureIdentity = recordedEvidenceClosureIdentity(input);
  const receipt = {
    id: 'review',
    runId: 'run',
    claimId: claim.id,
    recipeRunId: input.claims!.recipeRunId,
    closureIdentity,
    snapshotIdentity: 'captured',
    verdict: 'confirmed' as const,
    moments: claim.moments,
    approver: { principalId: 'person', credentialId: 'credential', displayName: 'Reviewer' },
    reason: 'The view matches the expectation.',
    judgedAt: '2026-10-14T00:00:00Z',
  };
  const authority = {
    runId: 'run',
    recipeRunId: receipt.recipeRunId,
    closureIdentity,
    receipts: [receipt],
  };
  assert.deepEqual(
    deriveReviewedRecipeClaims(input).map(({ verdict }) => verdict),
    ['awaiting-review', 'awaiting-review'],
  );
  assert.deepEqual(
    deriveReviewedRecipeClaims(input, authority).map(({ verdict }) => verdict),
    ['proven', 'proven'],
  );
  assert.deepEqual(
    deriveReviewedRecipeClaims(input, {
      ...authority,
      receipts: [{ ...receipt, verdict: 'rejected' }],
    }).map(({ verdict }) => verdict),
    ['failed', 'failed'],
  );
  assert.deepEqual(
    deriveReviewedRecipeClaims(input, { ...authority, recipeRunId: 'other' }).map(
      ({ verdict }) => verdict,
    ),
    ['awaiting-review', 'awaiting-review'],
  );
  const invalid = { ...input, summary: { ...(input.summary as object), recipeRunId: 'other' } };
  assert.throws(() => deriveReviewedRecipeClaims(invalid, authority), /valid retained engine/);
  assert.equal(JSON.stringify(input), before);
});

test('file-content proof uses its executed read without an indexed artifact', () => {
  const fileNodes = new Map<string, ProofNode>([
    ['file', { action: 'assert_file', path: 'state.log', contains: 'ready', proves: ['AC1'] }],
  ]);
  const observed = { path: 'state.log', sizeBytes: 14, contains: 'ready', matched: true };
  const trace = [{ nodeId: 'file', action: 'assert_file', ok: true, output: observed }];
  const input = { ...base, nodes: fileNodes, trace };
  assert.equal(potentiallyEligibleProof('file', fileNodes), true);
  assert.equal(deriveRecipeClaims(input)[0]?.verdict, 'proven');
  const failed = {
    nodeId: 'file',
    action: 'assert_file',
    ok: false,
    cause_class: 'subject',
    error_details: { ...observed, matched: false },
  };
  assert.equal(deriveRecipeClaims({ ...input, trace: [failed] })[0]?.verdict, 'failed');
  assert.equal(deriveRecipeClaims({ ...input, trace: [...trace, failed] })[0]?.verdict, 'failed');
  const retryNodes = new Map(fileNodes);
  retryNodes.set('file', { ...fileNodes.get('file')!, retryGroup: 'file-content' });
  assert.equal(
    deriveRecipeClaims({ ...input, nodes: retryNodes, trace: [failed, ...trace] })[0]?.verdict,
    'proven',
  );
  assert.equal(
    deriveRecipeClaims({ ...input, trace: [{ ...failed, cause_class: 'environment' }] })[0]
      ?.verdict,
    'missing',
  );
  assert.equal(deriveRecipeClaims({ ...input, trace: [] })[0]?.verdict, 'missing');
});

test('file existence, blank expectations and old unobserved outputs cannot prove contents', () => {
  for (const contains of [undefined, '', ' ']) {
    const fileNodes = new Map<string, ProofNode>([
      ['file', { action: 'assert_file', path: 'state.log', contains, proves: ['AC1'] }],
    ]);
    assert.equal(potentiallyEligibleProof('file', fileNodes), false);
    assert.equal(
      deriveRecipeClaims({
        ...base,
        nodes: fileNodes,
        trace: [
          {
            nodeId: 'file',
            action: 'assert_file',
            ok: true,
            output: { path: 'state.log', sizeBytes: 14 },
          },
        ],
      })[0]?.verdict,
      'missing',
    );
  }
  const fileNodes = new Map<string, ProofNode>([
    [
      'file',
      {
        action: 'assert_file',
        path: 'state.log',
        contains: '{{params.expected}}',
        proves: ['AC1'],
      },
    ],
  ]);
  for (const output of [
    { path: 'state.log', sizeBytes: 14 },
    { path: 'state.log', contains: ' ', matched: true },
  ]) {
    assert.equal(
      deriveRecipeClaims({
        ...base,
        nodes: fileNodes,
        trace: [{ nodeId: 'file', action: 'assert_file', ok: true, output }],
      })[0]?.verdict,
      'missing',
    );
  }
  const jsonNodes = new Map<string, ProofNode>([
    [
      'file',
      {
        action: 'assert_json',
        path: 'state.json',
        assert: { path: '$.ready', operator: 'eq', value: true },
        proves: ['AC1'],
      },
    ],
  ]);
  assert.equal(
    deriveRecipeClaims({
      ...base,
      nodes: jsonNodes,
      trace: [{ nodeId: 'file', action: 'assert_json', ok: true, output: { matched: true } }],
    })[0]?.verdict,
    'missing',
  );
});

test('an executed observation-bound expectation derives state proof, not action success', () => {
  assert.equal(deriveRecipeClaims(base)[0]?.verdict, 'proven');
  const captureOnly = {
    ...base,
    nodes: new Map([['capture', { action: 'ui.screenshot', proves: ['AC1'] }]]),
    trace: [
      { nodeId: 'capture', action: 'ui.screenshot', ok: true, output: { file: 'image.png' } },
    ],
  };
  assert.equal(deriveRecipeClaims(captureOnly)[0]?.verdict, 'missing');
});

test('a later failed assertion cannot reuse an earlier successful result', () => {
  const trace = [...base.trace, { nodeId: 'assert', action: 'assert_output', ok: false }];
  assert.equal(deriveRecipeClaims({ ...base, trace })[0]?.verdict, 'failed');
  assert.equal(executedProofIndex('assert', nodes, trace, []), 2);
});

test('visual evidence waits for review and refers to this attempt without stored clock values', () => {
  const visual = {
    ...base,
    declarations: [{ ...base.declarations[0]!, proofMode: 'visual' as const }],
    segments: [{ videoPath: 'video.mp4', videoDigest: `sha256:${'a'.repeat(64)}` }],
  };
  const claim = deriveRecipeClaims(visual)[0]!;
  assert.equal(claim.verdict, 'awaiting-review');
  assert.deepEqual(claim.moments, [
    { recipeRunId: 'attempt-a', videoDigest: visual.segments[0]!.videoDigest, traceIndex: 1 },
  ]);
  assert.equal(deriveRecipeClaims({ ...visual, segments: [] })[0]?.verdict, 'weak');
});

test('required QA child failure and absence propagate to the case', () => {
  const declarations = [
    { id: 'case-a', claim: 'The counter works.', kind: 'qa-case' as const },
    { id: 'AC1', claim: 'It is one.', kind: 'qa-check' as const, parentId: 'case-a' },
  ];
  const failed = deriveRecipeClaims({
    ...base,
    declarations,
    trace: [...base.trace, { nodeId: 'assert', action: 'assert_output', ok: false }],
  });
  assert.equal(failed[0]?.verdict, 'failed');
  const missing = deriveRecipeClaims({ ...base, declarations, trace: [] });
  assert.equal(missing[0]?.verdict, 'missing');
});

test('a failed composed call does not promote an earlier passed child assertion', () => {
  const composedNodes = new Map<string, ProofNode>([
    ['journey', { action: 'call' }],
    ['journey/read', { action: 'state_read' }],
    [
      'journey/assert',
      {
        action: 'assert_output',
        source: 'read',
        assert: { path: '$.count', operator: 'eq', value: 1 },
      },
    ],
  ]);
  const trace = [
    { nodeId: 'journey/read', action: 'state_read', ok: true, output: {} },
    { nodeId: 'journey/assert', action: 'assert_output', ok: true, output: {} },
    { nodeId: 'journey', action: 'call', ok: false },
  ];
  assert.equal(executedProofIndex('journey', composedNodes, trace, []), 2);
  const interrupted = [...trace.slice(0, 2), { ...trace[2]!, cause_class: 'environment' }];
  assert.equal(executedProofIndex('journey', composedNodes, interrupted, []), null);
  assert.equal(
    deriveRecipeClaims({
      ...base,
      nodes: new Map(
        [...composedNodes].map(([id, node]) => [
          id,
          id === 'journey' ? { ...node, proves: ['AC1'] } : node,
        ]),
      ),
      trace: interrupted,
    })[0]?.verdict,
    'missing',
  );
});

test('ordinary repetitions retain failure; only a declared retry may supersede it', () => {
  const trace = [
    ...base.trace.slice(0, 1),
    { nodeId: 'assert', action: 'assert_output', ok: false },
    ...base.trace,
  ];
  assert.equal(deriveRecipeClaims({ ...base, trace })[0]?.verdict, 'failed');
  const retryNodes = new Map(nodes);
  retryNodes.set('assert', { ...nodes.get('assert')!, retryGroup: 'counter-check' });
  assert.equal(deriveRecipeClaims({ ...base, nodes: retryNodes, trace })[0]?.verdict, 'proven');
});

test('a visual or mixed claim that only shell output proves is refused before the run', () => {
  const recipe = (proofMode: 'visual' | 'mixed' | 'state') => ({
    proofTargets: [
      { id: 'AC1', claim: 'The SDK is current.', proofMode },
      { id: 'AC2', claim: 'The screen shows the list.', proofMode: 'mixed' as const },
    ],
    workflow: {
      nodes: {
        // AC1 rests only on a command's output (ba397e2c: SDK version and expo-doctor checks).
        sdk: { action: 'command', cmd: 'node -p 1', next: 'assert-sdk' },
        'assert-sdk': {
          action: 'assert_output',
          source: 'sdk',
          assert: { path: '$', operator: 'eq', value: 1 },
          proves: ['AC1'],
          next: 'list',
        },
        // An adapter's own UI query counts as on-screen proof (ba397e2c: echobridge.ui.query).
        list: { action: 'echobridge.ui.query', target: 'list', next: 'assert-list' },
        'assert-list': {
          action: 'assert_output',
          source: 'list',
          assert: { path: '$', operator: 'contains', value: 'two rows' },
          proves: ['AC2'],
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  for (const mode of ['visual', 'mixed'] as const) {
    // Planning a recorded package (gate re-derivation) still accepts it; only a run refuses.
    const plan = planRecipeEvidence(recipe(mode), new Map());
    assert.throws(
      () => assertVisualClaimsObserveUi(plan),
      new RegExp(
        `Only shell commands and file or log checks prove these visual or mixed claims, so the recording cannot show them: AC-1 \\(${mode}\\)\\. .*or declare proofMode state`,
      ),
    );
  }
  // A state claim, and a mixed claim asserted on an app's UI query, plan as before.
  assertVisualClaimsObserveUi(planRecipeEvidence(recipe('state'), new Map()));
});

test('the visual-claim check follows calls, re-reads, file and log checks and child claims', () => {
  const shellCheck = (source: Record<string, unknown>) => ({
    proofTargets: [{ id: 'check', claim: 'The checks pass.', proofMode: 'mixed' as const }],
    workflow: {
      nodes: {
        read: { ...source, next: 'assert' },
        assert: {
          action: 'assert_output',
          source: 'read',
          assert: { path: '$', operator: 'eq', value: 0 },
          proves: ['check'],
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  const viaCall = (child: ReturnType<typeof shellCheck>, provedByCall = false) =>
    planRecipeEvidence(
      {
        proofTargets: [{ id: 'AC1', claim: 'The checks pass.', proofMode: 'mixed' as const }],
        workflow: {
          nodes: {
            step: provedByCall
              ? { action: 'call', ref: 'checks', proves: ['AC1'], next: 'done' }
              : { action: 'call', ref: 'checks', claimBindings: { check: 'AC1' }, next: 'done' },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
      new Map([['checks', child]]),
    );
  const shell = shellCheck({ action: 'command', cmd: 'yarn tsc' });
  const ui = shellCheck({ action: 'echobridge.ui.query', target: 'x' });
  // A shared library check called from the task recipe, its `end` included.
  assert.throws(() => assertVisualClaimsObserveUi(viaCall(shell)), /them: AC-1 \(mixed\)\./);
  assertVisualClaimsObserveUi(viaCall(ui));
  // A call that proves the claim itself walks the whole callee; its `end` shows nothing. Every
  // refused claim is named at once, the callee's own claim included.
  assert.throws(
    () => assertVisualClaimsObserveUi(viaCall(shell, true)),
    /them: AC-1 \(mixed\), step\/check \(mixed\)\./,
  );
  assertVisualClaimsObserveUi(viaCall(ui, true));
  // A log read, and a command re-read through state_read, are off screen too.
  for (const nodes of [
    { read: { action: 'watch_logs', path: 'app.log', contains: 'ready' } },
    {
      cmd: { action: 'command', cmd: 'node -p 1', next: 'read' },
      read: { action: 'state_read', source: 'cmd', path: '$' },
    },
  ]) {
    const child = shellCheck({});
    child.workflow.nodes = { ...child.workflow.nodes, ...nodes } as typeof child.workflow.nodes;
    assert.throws(() => assertVisualClaimsObserveUi(viaCall(child)), /AC-1 \(mixed\)/);
  }
  // A re-read of a UI query is followed to the query, so it stays on screen.
  const reread = shellCheck({});
  reread.workflow.nodes = {
    ...reread.workflow.nodes,
    query: { action: 'echobridge.ui.query', target: 'x', next: 'read' },
    read: { action: 'state_read', source: 'query', path: '$' },
  } as typeof reread.workflow.nodes;
  assertVisualClaimsObserveUi(viaCall(reread));
  // A file assertion proves nothing the recording shows.
  assert.throws(
    () =>
      assertVisualClaimsObserveUi(
        planRecipeEvidence(
          {
            proofTargets: [{ id: 'AC1', claim: 'The change is minimal.', proofMode: 'visual' }],
            workflow: {
              nodes: {
                marker: {
                  action: 'assert_file',
                  path: 'artifacts/pr-description.md',
                  contains: 'DO NOT MERGE',
                  proves: ['AC1'],
                  next: 'done',
                },
                done: { action: 'end', status: 'pass' },
              },
            },
          },
          new Map(),
        ),
      ),
    /AC-1 \(visual\)/,
  );
  // A mixed parent whose child claim is shown on screen keeps its mode.
  assertVisualClaimsObserveUi(
    planRecipeEvidence(
      {
        proofTargets: [
          { id: 'AC1', claim: 'The value is saved and shown.', proofMode: 'mixed' },
          { id: 'AC1a', claim: 'The value is shown.', proofMode: 'visual', parentId: 'AC1' },
        ],
        workflow: {
          nodes: {
            saved: { action: 'command', cmd: 'cat saved.json', next: 'assert-saved' },
            'assert-saved': {
              action: 'assert_output',
              source: 'saved',
              assert: { path: '$.value', operator: 'eq', value: 1 },
              proves: ['AC1'],
              next: 'shown',
            },
            shown: { action: 'echobridge.ui.query', target: 'value', next: 'assert-shown' },
            'assert-shown': {
              action: 'assert_output',
              source: 'shown',
              contains: '1',
              proves: ['AC1a'],
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
      new Map(),
    ),
  );
});

test('two composed calls retain separate claims and explicit parent bindings', () => {
  const child = {
    proofTargets: [{ id: 'check', claim: 'The counter is one.', proofMode: 'state' as const }],
    workflow: {
      nodes: {
        read: { action: 'state_read' },
        assert: {
          action: 'assert_output',
          source: 'read',
          assert: { path: '$.count', operator: 'eq', value: 1 },
          proves: ['check'],
        },
      },
    },
  };
  const root = {
    proofTargets: [{ id: 'AC1', claim: 'The counter is one.' }],
    workflow: {
      nodes: {
        first: { action: 'call', ref: 'counter', claimBindings: { check: 'AC1' } },
        second: { action: 'call', ref: 'counter' },
      },
    },
  };
  const plan = planRecipeEvidence(root, new Map([['counter', child]]));
  assert.deepEqual(
    plan.declarations.map((claim) => claim.id),
    ['AC-1', 'second/check'],
  );
  assert.deepEqual(plan.nodes.get('first/assert')?.proves, ['AC-1']);
  assert.deepEqual(plan.nodes.get('second/assert')?.proves, ['second/check']);
  assert.deepEqual(
    child.workflow.nodes.assert.proves,
    ['check'],
    'planning cannot mutate source documents',
  );
});

test('task registration retains required unmentioned claims and rejects invented acceptance ids', () => {
  const recipe = {
    proofTargets: [{ id: 'AC1', claim: 'The counter is one.' }],
    workflow: { nodes: Object.fromEntries(nodes) },
  };
  const registry = [base.declarations[0]!, { id: 'AC2', claim: 'The second check is required.' }];
  const plan = planRecipeEvidence(recipe, new Map(), registry);
  assert.equal(deriveRecipeClaims({ ...base, ...plan })[1]?.verdict, 'missing');
  assert.throws(
    () => planRecipeEvidence(recipe, new Map(), [{ id: 'AC2', claim: 'Other.' }]),
    /not registered/,
  );
  assert.throws(
    () =>
      planRecipeEvidence(
        {
          ...recipe,
          workflow: { nodes: { screenshot: { action: 'ui.screenshot', proves: ['AC1'] } } },
        },
        new Map(),
      ),
    /without an observation-bound expectation/,
  );
});

test('only the code review proves a review claim; it is never missing and no node proves it', () => {
  const review = {
    id: 'AC2',
    claim: 'The change is easy to revert.',
    proofMode: 'review' as const,
  };
  const declarations = [base.declarations[0]!, review];
  const awaiting = deriveRecipeClaims({ ...base, declarations })[1]!;
  assert.equal(awaiting.verdict, 'awaiting-review');
  assert.deepEqual(awaiting.recipeNodes, []);
  assert.equal(awaiting.note, undefined);
  assert.equal(
    deriveRecipeClaims({ ...base, declarations, codeReviewCertified: true })[1]?.verdict,
    'proven',
  );
  // A parent re-aggregates with its review child, and a review parent with its own verdict.
  const children = [
    { id: 'case-a', claim: 'The change ships.', kind: 'qa-case' as const },
    { ...base.declarations[0]!, kind: 'qa-check' as const, parentId: 'case-a' },
    { ...review, kind: 'qa-check' as const, parentId: 'case-a' },
  ];
  assert.equal(
    deriveRecipeClaims({ ...base, declarations: children })[0]?.verdict,
    'awaiting-review',
  );
  assert.equal(
    deriveRecipeClaims({ ...base, declarations: children, codeReviewCertified: true })[0]?.verdict,
    'proven',
  );
  const reviewParent = [
    { ...review, kind: 'qa-case' as const },
    { ...base.declarations[0]!, kind: 'qa-check' as const, parentId: 'AC2' },
  ];
  assert.equal(
    deriveRecipeClaims({ ...base, declarations: reviewParent })[0]?.verdict,
    'awaiting-review',
  );
  assert.equal(
    deriveRecipeClaims({ ...base, declarations: reviewParent, codeReviewCertified: true })[0]
      ?.verdict,
    'proven',
  );
  assert.throws(
    () =>
      planRecipeEvidence(
        {
          proofTargets: [{ ...base.declarations[0]!, proofMode: 'review' }],
          workflow: { nodes: Object.fromEntries(nodes) },
        },
        new Map(),
      ),
    /Node assert proves review claim AC-1; only the code review checks it/,
  );
});

test('measured proof outside the captured span is weak and never linked as a valid moment', () => {
  const segment = { videoPath: 'video.mp4', videoDigest: `sha256:${'a'.repeat(64)}` };
  const timeline = {
    version: 1 as const,
    videoPath: segment.videoPath,
    videoDigest: segment.videoDigest,
    traceDigest: `sha256:${'b'.repeat(64)}`,
    durationMs: 100,
    framesMs: [0, 33],
    clock: { source: 'measured', earliestZeroUnixMs: 0, latestZeroUnixMs: 0 },
    markers: [
      {
        traceIndex: 1,
        nodeId: 'assert',
        action: 'assert_output',
        ok: true,
        startRangeMs: [90, 90] as [number, number],
        endRangeMs: [110, 110] as [number, number],
      },
    ],
  };
  const claim = deriveRecipeClaims({
    ...base,
    declarations: [{ ...base.declarations[0]!, proofMode: 'visual' }],
    segments: [segment],
    timelines: new Map([[segment.videoPath, timeline]]),
  })[0]!;
  assert.equal(claim.verdict, 'weak');
  assert.equal(claim.timing, 'outside-recording');
  assert.deepEqual(claim.moments, []);
});

test('parent call retains every executed child expectation, not only the last', () => {
  const composedNodes = new Map<string, ProofNode>([
    ['journey', { action: 'call', proves: ['AC1'] }],
    ['journey/read', { action: 'state_read' }],
    ['journey/first', { action: 'assert_output', source: 'read', contains: 'one' }],
    ['journey/second', { action: 'assert_output', source: 'read', contains: 'two' }],
  ]);
  const trace = [
    { nodeId: 'journey/read', action: 'state_read', ok: true, output: {} },
    { nodeId: 'journey/first', action: 'assert_output', ok: true, output: {} },
    { nodeId: 'journey/second', action: 'assert_output', ok: true, output: {} },
    { nodeId: 'journey', action: 'call', ok: true, output: {} },
  ];
  const claim = deriveRecipeClaims({ ...base, nodes: composedNodes, trace })[0]!;
  assert.deepEqual(claim.assertionIndices, [1, 2]);
  assert.equal(claim.verdict, 'proven');
});

test('package validation refuses omitted registered claim rows', () => {
  const declarations = [
    { id: 'first', claim: 'The counter is one.', proofMode: 'state' as const },
    { id: 'second', claim: 'The observed value is one.', proofMode: 'state' as const },
  ];
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Retain every registered state claim.',
    proofTargets: declarations,
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'state_read', intent: 'Read the counter', next: 'assert' },
        assert: {
          action: 'assert_output',
          source: 'read',
          assert: { path: '$.count', operator: 'eq', value: 1 },
          proves: ['first', 'second'],
          intent: 'Verify the observed count',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const trace = [
    {
      nodeId: 'read',
      action: 'state_read',
      intent: 'Read the counter',
      ok: true,
      output: { count: 1 },
      next: 'assert',
    },
    {
      nodeId: 'assert',
      action: 'assert_output',
      intent: 'Verify the observed count',
      ok: true,
      output: { matched: true },
      next: 'done',
    },
    { nodeId: 'done', action: 'end', ok: true, status: 'pass' },
  ].map((entry) => ({
    ...entry,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:00:00Z',
    durationMs: 0,
  }));
  const invocation = {
    version: 1,
    recipeDigest: digestRecipeDocument(recipe),
    recipeRunId: 'claim-completeness',
    startedAt: '2026-01-01T00:00:00Z',
    params: {},
    redactedPaths: [],
  };
  const claims = {
    schemaVersion: 2 as const,
    recipeRunId: 'claim-completeness',
    criteria: deriveRecipeClaims({
      recipeRunId: 'claim-completeness',
      declarations,
      nodes: new Map(Object.entries(recipe.workflow.nodes)),
      trace,
      artifacts: [],
      segments: [],
    }),
    recording: { status: 'not-required' as const, segments: [] },
  };
  const bundle = {
    recipe,
    trace: { metadata: { recipeRunId: 'claim-completeness' }, entries: trace },
    invocation,
    recipeRunId: claims.recipeRunId,
    claims,
    summary: {
      recipeRunId: 'claim-completeness',
      status: 'pass',
      total: 3,
      passed: 3,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
      invocationDigest: digestRecipeDocument(invocation),
    },
    recipeResolution: {
      schema_version: 1,
      root: { ref: '$root', digest: digestRecipeDocument(recipe) },
      dependencies: [],
      edges: [],
    },
    resolvedRecipes: {},
    artifactDigests: {},
    timelines: {},
    manifest: {
      version: 1,
      runStatus: 'pass',
      artifacts: [
        { path: 'recipe.json', type: 'recipe' },
        { path: 'trace.json', type: 'trace' },
        { path: 'summary.json', type: 'summary' },
        { path: 'acceptance-status.json', type: 'json' },
      ],
    },
    artifactPaths: [
      'recipe.json',
      'trace.json',
      'summary.json',
      'acceptance-status.json',
      'artifact-manifest.json',
      'recipe-resolution.json',
      'recipe-invocation.json',
    ],
  };
  const valid = validateRecordedEvidencePackage(bundle);
  assert.equal(valid.status, 'valid', JSON.stringify(valid.findings));
  const missingRecipe = validateRecordedEvidencePackage({ ...bundle, recipe: undefined });
  assert.equal(missingRecipe.status, 'invalid');
  assert.ok(missingRecipe.findings.some((finding) => finding.path === 'recipe.json'));
  for (const retained of [claims.criteria.slice(0, 1), []]) {
    const result = validateRecordedEvidencePackage({
      ...bundle,
      claims: { ...claims, criteria: retained },
    });
    assert.equal(result.status, 'invalid');
    assert.ok(result.findings.some((finding) => finding.path === 'claims.second'));
  }
});

test('a retry ending without an eligible assertion cannot reuse earlier state proof', () => {
  const retryNodes = new Map(nodes);
  retryNodes.set('assert', { ...nodes.get('assert')!, retryGroup: 'counter-check' });
  const trace = [
    ...base.trace,
    { nodeId: 'assert', action: 'assert_output', ok: false, cause_class: 'environment' },
  ];
  assert.equal(deriveRecipeClaims({ ...base, nodes: retryNodes, trace })[0]?.verdict, 'missing');
});

test('a visual judgment binds exact moments and cannot turn missing proof into proven', () => {
  const segment = { videoPath: 'video.mp4', videoDigest: `sha256:${'a'.repeat(64)}` };
  const visual = {
    ...base,
    declarations: [{ ...base.declarations[0]!, proofMode: 'visual' as const }],
    segments: [segment],
  };
  const awaiting = deriveRecipeClaims(visual)[0]!;
  const judgment = {
    claimId: awaiting.id,
    recipeRunId: base.recipeRunId,
    verdict: 'confirmed' as const,
    moments: awaiting.moments,
    actor: 'reviewer',
    reason: 'The retained clip confirms the claim.',
    judgedAt: '2026-01-01T00:00:00Z',
  };
  assert.equal(deriveRecipeClaims({ ...visual, judgments: [judgment] })[0]?.verdict, 'proven');
  const forged = { ...judgment, reason: '', kind: 'person-reviewed' as const, receiptId: 'forged' };
  assert.throws(() => deriveRecipeClaims({ ...visual, judgments: [forged] }), /does not bind/);
  assert.equal(
    deriveRecipeClaims(visual, [
      {
        ...forged,
        reviewer: { principalId: 'reviewer', credentialId: 'credential', displayName: 'Reviewer' },
      },
    ])[0]?.verdict,
    'proven',
  );
  assert.equal(
    deriveRecipeClaims({ ...visual, judgments: [{ ...judgment, verdict: 'rejected' }] })[0]
      ?.verdict,
    'failed',
  );
  assert.throws(
    () =>
      deriveRecipeClaims({
        ...visual,
        judgments: [{ ...judgment, recipeRunId: 'another-attempt' }],
      }),
    /does not bind/,
  );
  assert.equal(
    deriveRecipeClaims({ ...visual, trace: [], judgments: [judgment] })[0]?.verdict,
    'missing',
  );
});

test('new recorded packages cannot skip the claim ledger, while legacy inspection stays untimed', () => {
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
  };
  const trace = [
    {
      nodeId: 'done',
      action: 'end',
      ok: true,
      status: 'pass',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:00Z',
      durationMs: 0,
    },
  ];
  const bundle = {
    recipe,
    trace,
    summary: {
      status: 'pass',
      total: 1,
      passed: 1,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    },
    recipeResolution: {
      schema_version: 1,
      root: { ref: '$root', digest: digestRecipeDocument(recipe) },
      dependencies: [],
      edges: [],
    },
    resolvedRecipes: {},
    artifactDigests: {},
    timelines: {},
    manifest: {
      version: 1,
      runStatus: 'pass',
      artifacts: [
        { path: 'recipe.json', type: 'recipe' },
        { path: 'trace.json', type: 'trace' },
        { path: 'summary.json', type: 'summary' },
      ],
    },
    artifactPaths: [
      'recipe.json',
      'trace.json',
      'summary.json',
      'artifact-manifest.json',
      'recipe-resolution.json',
    ],
  };
  const legacy = validateRecordedEvidencePackage(bundle);
  assert.equal(legacy.status, 'valid', JSON.stringify(legacy.findings));
  assert.ok(
    legacy.findings.some(
      (finding) => finding.severity === 'warning' && finding.message.includes('Legacy'),
    ),
  );
  assert.equal(
    validateRecordedEvidencePackage({
      ...bundle,
      summary: { ...bundle.summary, recipeRunId: 'new-run' },
    }).status,
    'invalid',
  );
  assert.equal(
    validateRecordedEvidencePackage({
      ...bundle,
      manifest: {
        ...bundle.manifest,
        artifacts: [...bundle.manifest.artifacts, { path: 'acceptance-status.json', type: 'json' }],
      },
      artifactPaths: [...bundle.artifactPaths, 'acceptance-status.json'],
    }).status,
    'invalid',
  );
});
