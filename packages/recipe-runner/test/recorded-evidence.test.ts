import assert from 'node:assert/strict';
import test from 'node:test';

import { digestRecipeDocument } from '@farmslot/protocol';

import { executedProofIndex, type ProofNode } from '../src/evidence/assertions.js';
import { deriveRecipeClaims, type DeriveRecipeClaimsInput } from '../src/evidence/claims.js';
import { validateRecordedEvidencePackage } from '../src/evidence/package.js';
import { planRecipeEvidence } from '../src/evidence/plan.js';

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
    timelines: new Map([[segment.videoDigest, timeline]]),
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
