// Isolated source fixtures for the living gate browser/RPC proof. No product run is mutated.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function prepareCodeReviewGate({
  sourceModule,
  source,
  store,
  run,
  root,
  mock,
  headSha,
}) {
  const protocol = await sourceModule('packages/protocol/src/index.ts');
  const { readRecordedEvidencePackage } = await sourceModule('packages/adapter-sdk/src/index.ts');
  const { makeReadyGatePackage, retainRunFixture } = await sourceModule(
    'services/gateway/src/run-engine/test-fixtures.ts',
  );
  const { computeReadyGatePackageHash } = await sourceModule(
    'services/gateway/src/run-completion/ready-gate-package.ts',
  );
  const task = path.join(root, 'task');
  const directory = path.join(task, 'artifacts/recipe-runs/proof');
  await mkdir(directory, { recursive: true });
  const texts = [
    'The recorded value is one.',
    'The address is defined in a single config location.',
    'The external service responds.',
    'Tests cover the fee wallet being applied to orders.',
  ];
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Gate criteria fixture',
    proofTargets: texts.map((claim, i) => ({
      id: `AC-${i + 1}`,
      claim,
      proofMode: [1, 3].includes(i) ? 'review' : 'state',
    })),
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'state_read', intent: 'Read the fixture', next: 'assert' },
        assert: {
          action: 'assert_output',
          source: 'read',
          assert: { path: '$.count', operator: 'eq', value: 1 },
          proves: ['AC-1'],
          intent: 'Check the recorded value',
          next: 'assert-external',
        },
        'assert-external': {
          action: 'assert_output',
          source: 'read',
          assert: { path: '$.external', operator: 'eq', value: true },
          proves: ['AC-3'],
          intent: 'Check the external service',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const startedAt = new Date().toISOString();
  const invocation = {
    version: 1,
    recipeDigest: protocol.digestRecipeDocument(recipe),
    recipeRunId: 'gate-criteria-proof',
    startedAt,
    params: {},
    redactedPaths: [],
  };
  const claims = {
    schemaVersion: 2,
    recipeRunId: invocation.recipeRunId,
    criteria: texts.map((text, i) => ({
      id: `AC-${i + 1}`,
      text,
      kind: 'acceptance',
      proofMode: [1, 3].includes(i) ? 'review' : 'state',
      verdict: i === 0 ? 'proven' : i === 2 ? 'missing' : 'awaiting-review',
      recipeNodes: i === 0 ? ['assert'] : [],
      assertionIndices: i === 0 ? [1] : [],
      moments: [],
      evidence: [],
    })),
    recording: { status: 'not-required', segments: [] },
  };
  const entries = [
    {
      nodeId: 'read',
      action: 'state_read',
      intent: 'Read the fixture',
      ok: true,
      output: { count: 1 },
    },
    {
      nodeId: 'assert',
      action: 'assert_output',
      intent: 'Check the recorded value',
      ok: true,
      output: { count: 1 },
      assertion: { passed: true },
    },
    { nodeId: 'done', action: 'end', status: 'pass', ok: true },
  ].map((entry) => ({ ...entry, startedAt, endedAt: startedAt, durationMs: 0 }));
  const documents = {
    'recipe.json': recipe,
    'recipe-invocation.json': invocation,
    'acceptance-status.json': claims,
    'recipe-resolution.json': {
      schema_version: 1,
      root: { ref: '$root', digest: protocol.digestRecipeDocument(recipe) },
      dependencies: [],
      edges: [],
    },
    'trace.json': { entries },
    'summary.json': {
      recipeRunId: invocation.recipeRunId,
      status: 'pass',
      total: 3,
      passed: 3,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
      invocationDigest: protocol.digestRecipeDocument(invocation),
    },
    'artifact-manifest.json': {
      version: 1,
      runStatus: 'pass',
      artifacts: [
        { path: 'recipe.json', type: 'recipe' },
        { path: 'trace.json', type: 'trace' },
        { path: 'summary.json', type: 'summary' },
        { path: 'acceptance-status.json', type: 'json' },
      ],
    },
  };
  const inventory = [];
  for (const [file, value] of Object.entries(documents)) {
    const bytes = JSON.stringify(value);
    await writeFile(path.join(directory, file), bytes);
    inventory.push({
      path: `artifacts/recipe-runs/proof/${file}`,
      purpose: 'json',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const input = (await readRecordedEvidencePackage(directory)).input;
  const adapter = await sourceModule('packages/adapter-sdk/src/evidence.ts');
  const validation = adapter.validateRecordedEvidencePackage(input);
  assert.equal(validation.status, 'valid', JSON.stringify(validation.findings));
  const prepared = makeReadyGatePackage({
    reviewSnapshot: undefined,
    headSha,
    branch: 'proof',
    remoteBranchRef: 'proof',
    diffStat: { files: 5, additions: 5, deletions: 0 },
    evidenceManifest: [],
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  await writeFile(path.join(task, 'TASK.md'), '# Gate proof fixture\n');
  await writeFile(
    path.join(task, 'artifacts/pr-description.md'),
    '# fix(command-center): harden gate\n\n## Summary\n\nIsolated gate proof.\n',
  );
  const readiness = (current) => ({
    state: 'not-ready',
    identity: {
      runId: current.id,
      generation: 0,
      packageHash: current.decisions[0].payload.prPackage.packageHash,
    },
    reasons: [
      {
        code: 'evidence-policy-unsatisfied',
        prerequisite: 'evidence',
        evidencePolicy: 'claim-verdict',
        message: 'Recorded criteria need approval.',
      },
    ],
  });
  const decision = {
    id: 'proof-gate',
    type: 'engine_human_gate',
    title: 'Gate criterion proof',
    description: 'Private fixture',
    createdAt: startedAt,
    actions: [
      protocol.EVIDENCE_ATTESTATION_ACTION,
      { id: 'hold', label: 'Hold', style: 'secondary' },
    ],
    payload: {
      kind: 'ready',
      branch: prepared.branch,
      repo: null,
      prNumber: null,
      workerReport: 'Isolated fixture.',
      diffStat: prepared.diffStat,
      prPackage: prepared,
      acceptanceCriteria: [...texts, 'The additional criterion has no recorded evidence.'],
      acceptanceStatus: claims,
    },
  };
  store.updateRun(run.id, {
    status: 'human-gating',
    taskFile: path.join(task, 'TASK.md'),
    decisions: [decision],
    engineState: {
      generation: 0,
      publishGate: {
        packageId: prepared.id,
        packageHash: prepared.packageHash,
        publicationStatus: 'not_published',
      },
    },
  });
  await retainRunFixture(store.getRun(run.id), prepared);
  const { claimOverrideAuthority } = await sourceModule(
    'services/gateway/src/run-engine/claim-overrides.ts',
  );
  const refresh = async () => {
    const current = store.getRun(run.id);
    const d = current.decisions[0];
    const pkg = {
      ...d.payload.prPackage,
      claimOverrideReceiptIds: (current.claimOverrideReceipts ?? []).map(({ id }) => id),
    };
    pkg.packageHash = computeReadyGatePackageHash(pkg);
    store.updateRun(run.id, {
      decisions: [
        {
          ...d,
          payload: {
            ...d.payload,
            prPackage: pkg,
            acceptanceStatus: {
              ...claims,
              criteria: adapter.selectedRecipeClaims(input, claimOverrideAuthority(current, input)),
            },
          },
        },
      ],
    });
    const updated = store.getRun(run.id);
    updated.engineState.publishGate.packageHash = pkg.packageHash;
    await retainRunFixture(updated, pkg);
    updated.decisions[0].payload.gateReadiness = readiness(updated);
    return { run: updated };
  };
  decision.payload.gateReadiness = readiness(store.getRun(run.id));
  // Fixture readiness is a controlled source boundary. Authentication, snapshot
  // consumption and both durable receipt writers remain the production methods.
  const prerequisites = await sourceModule('services/gateway/src/run-engine/gate-prerequisites.ts');
  mock.module(path.join(source, 'services/gateway/src/run-engine/gate-prerequisites.ts'), {
    namedExports: { ...prerequisites, refreshRunGateReadiness: async (current) => current },
  });
  const context = await sourceModule('services/gateway/src/methods/run/context.ts');
  mock.module(path.join(source, 'services/gateway/src/methods/run/context.ts'), {
    namedExports: {
      ...context,
      runGet: async ({ runId }) => ({ run: store.getRun(runId) }),
      runRecipeRunsForRun: async () => ({
        recipeRuns: [],
        selectedRecipeRunId: null,
        recordedEvidence: {
          errors: [],
          contractVersion: 1,
          packagePath: 'recipe-runs/proof',
          input,
          claimOverrideAuthority: claimOverrideAuthority(store.getRun(run.id), input),
          visualReviewAuthority: {
            runId: run.id,
            recipeRunId: claims.recipeRunId,
            closureIdentity: protocol.recordedEvidenceClosureIdentity(input),
            receipts: [],
          },
          visualReviewContext: {
            decisionId: decision.id,
            snapshotIdentity: store.getRun(run.id).decisions[0].payload.prPackage.packageHash,
          },
          artifactPrefix: 'artifacts/recipe-runs/proof/',
        },
      }),
    },
  });
  const overrides = await sourceModule('services/gateway/src/methods/run/claim-overrides.ts');
  mock.module(path.join(source, 'services/gateway/src/methods/run/claim-overrides.ts'), {
    namedExports: {
      ...overrides,
      runOverrideClaim: (params, emit, dependencies) =>
        overrides.runOverrideClaim(params, emit, {
          ...dependencies,
          evidence: async () => [input],
          acceptance: async () => ({
            criteria: texts.map((text, i) => ({ id: `AC-${i + 1}`, text })),
            ledger: claims,
            issues: [],
          }),
          refreshPackage: refresh,
        }),
    },
  });
  let suppressedResumes = 0;
  const methods = await sourceModule('services/gateway/src/methods/run.ts');
  mock.module(path.join(source, 'services/gateway/src/methods/run.ts'), {
    namedExports: {
      ...methods,
      runResolveDecision: (params, emit, dependencies) =>
        methods.runResolveDecision(params, emit, {
          ...dependencies,
          assertGatePrerequisites: async () => readiness(store.getRun(run.id)),
          resumeRun: async () => {
            suppressedResumes++;
          },
        }),
    },
  });
  return {
    texts: decision.payload.acceptanceCriteria,
    runId: run.id,
    suppressedResumes: () => suppressedResumes,
  };
}

export async function proveCodeReviewGate({
  cdp,
  origin,
  run,
  output,
  save,
  events,
  store,
  releaseEvidence,
  releaseReplies,
  expectMissing,
  fixture,
}) {
  let route = `runs?run=${run.id}`;
  await cdp('goto', `${origin}/#${route}&tab=evidence`);
  const query = async (expression) => JSON.parse(await cdp('eval', route, expression));
  const read = () =>
    query(
      `const find=r=>{const g=r.querySelector('ready-workspace');if(g)return g;for(const e of r.querySelectorAll('*'))if(e.shadowRoot){const hit=find(e.shadowRoot);if(hit)return hit;}};const g=find(document);return {text:g?.innerText??'',rows:Array.from(g?.querySelectorAll('[data-ac-id]')??[]).map(e=>({id:e.dataset.acId,text:e.innerText})),confirm:!!g?.querySelector('[data-testid=criterion-confirm-AC-2]'),approve:g?.querySelector('[data-testid=gate-approve]')?.textContent};`,
    );
  let observed;
  const until = Date.now() + 30000;
  do {
    observed = await read();
    if (
      expectMissing
        ? observed.rows.some(({ id }) => id === 'AC-2')
        : observed.rows.length === fixture.texts.length
    )
      break;
    assert(Date.now() < until, 'Criterion rows did not mount');
  } while (Date.now() < until);
  assert(
    expectMissing
      ? observed.rows.some(({ id }) => id === 'AC-2')
      : observed.rows.length === fixture.texts.length,
    'Criterion rows did not mount',
  );
  await save('criteria-before-evidence.json', observed);
  if (expectMissing) {
    assert.equal(
      observed.confirm,
      false,
      'Prior source must lack the requested primary confirmation',
    );
    return;
  }
  assert(observed.text.includes('The address is defined in a single config location.'));
  assert(!observed.text.includes('Diff (0)'));
  assert(!observed.text.includes('No evidence files'));
  await cdp('screenshot', route, path.join(output, 'criteria-before-evidence.png'));
  await cdp('click', route, 'ready-workspace [data-testid=criterion-evidence-AC-2]');
  const header = await query(
    `const find=r=>{const hit=r.querySelector('evidence-reviewer');if(hit)return hit;for(const e of r.querySelectorAll('*'))if(e.shadowRoot){const hit=find(e.shadowRoot);if(hit)return hit;}};const reviewer=find(document);return {heading:reviewer?.shadowRoot?.querySelector('h2')?.textContent,text:reviewer?.shadowRoot?.querySelector('[data-testid=evidence-review-criterion]')?.textContent};`,
  );
  assert(header.heading.includes('AC-2'));
  assert.equal(header.text, 'The address is defined in a single config location.');
  await save('media-review-header.json', header);
  await cdp('screenshot', route, path.join(output, 'media-review-header.png'));
  await cdp('click', route, '[data-testid=evidence-review-close]');
  releaseEvidence();
  const readyUntil = Date.now() + 30000;
  while (
    !(await query(
      `const find=r=>{const g=r.querySelector('ready-workspace');if(g)return g;for(const e of r.querySelectorAll('*'))if(e.shadowRoot){const hit=find(e.shadowRoot);if(hit)return hit;}};const g=find(document);return !!g?.querySelector('[data-testid=criterion-confirm-AC-2]:not(:disabled)');`,
    ))
  ) {
    assert(Date.now() < readyUntil, 'Draft controls did not become ready');
  }
  const selector = (id) => `ready-workspace [data-testid=${id}]`;
  const unavailableSkip = await query(
    `const find=r=>{const g=r.querySelector('ready-workspace');if(g)return g;for(const e of r.querySelectorAll('*'))if(e.shadowRoot){const hit=find(e.shadowRoot);if(hit)return hit;}};const g=find(document);return {disabled:g?.querySelector('[data-testid=criterion-skip-AC-5]')?.disabled,text:g?.querySelector('[data-ac-id=AC-5]')?.innerText};`,
  );
  assert.equal(
    unavailableSkip.disabled,
    true,
    'An unmatched criterion must not offer an impossible skip',
  );
  assert(
    unavailableSkip.text.includes('This criterion has no recorded evidence that can be skipped.'),
  );
  await save('unavailable-skip.json', unavailableSkip);
  await query(
    `window.__criterionPressTimes=[];document.addEventListener('click',event=>{const button=event.composedPath().find(e=>e instanceof HTMLElement && /^criterion-(confirm|skip)-/.test(e.dataset.testid??''));if(!button)return;const row=button.closest('[data-ac-id]');const expected=button.dataset.testid.startsWith('criterion-skip-')?'Skipped':'Verified in code';const start=performance.now();const observer=new MutationObserver(()=>{if(!row.querySelector('.gate-state')?.textContent.includes(expected))return;window.__criterionPressTimes.push({id:row.dataset.acId,ms:performance.now()-start,trusted:event.isTrusted});observer.disconnect();});observer.observe(row,{subtree:true,characterData:true,childList:true});},{capture:true});return {observerReady:true};`,
  );
  const before = events.filter(({ method }) =>
    /^run\.(overrideClaim|resolveDecision|reviewVisualClaim)$/.test(method),
  ).length;
  for (const id of ['AC-2', 'AC-4']) await cdp('click', route, selector(`criterion-confirm-${id}`));
  assert.equal(
    await query(
      `const find=r=>{const g=r.querySelector('ready-workspace');if(g)return g;for(const e of r.querySelectorAll('*'))if(e.shadowRoot){const hit=find(e.shadowRoot);if(hit)return hit;}};return !!find(document)?.querySelector('[data-testid=criterion-skip-AC-2]');`,
    ),
    false,
    'A verified code criterion must have no Skip action',
  );
  await cdp('click', route, selector('criterion-skip-AC-3'));
  const { selector: noteSelector } = await query(
    `const find=r=>{const g=r.querySelector('ready-workspace');if(g)return g;for(const e of r.querySelectorAll('*'))if(e.shadowRoot){const hit=find(e.shadowRoot);if(hit)return hit;}};const note=find(document)?.querySelector('[data-testid=criterion-note-AC-2]');if(!note)throw Error('Expected the mounted note editor');const parts=['[data-testid=criterion-note-AC-2]'];let root=note.getRootNode();while(root.host){parts.unshift(root.host.localName);root=root.host.getRootNode();}return {selector:parts.join(' >>> ')};`,
  );
  await cdp('fill', route, noteSelector, 'One ');
  assert.deepEqual(
    await query(
      `const find=r=>{const g=r.querySelector('ready-workspace');if(g)return g;for(const e of r.querySelectorAll('*'))if(e.shadowRoot){const hit=find(e.shadowRoot);if(hit)return hit;}};return {value:find(document)?.querySelector('[data-testid=criterion-note-AC-2]')?.value};`,
    ),
    { value: 'One ' },
    'A note edit must retain its trailing space',
  );
  await cdp('fill', route, noteSelector, 'One configuration location.');
  observed = await read();
  assert(observed.approve.includes('2 confirmed, 1 skipped'));
  assert(observed.rows.find(({ id }) => id === 'AC-2').text.includes('Verified in code'));
  assert(observed.rows.find(({ id }) => id === 'AC-3').text.includes('Skipped'));
  assert.equal(
    events.filter(({ method }) =>
      /^run\.(overrideClaim|resolveDecision|reviewVisualClaim)$/.test(method),
    ).length,
    before,
    'Row drafts must not send mutation RPCs',
  );
  const latency = await query('return window.__criterionPressTimes;');
  assert.equal(latency.length, 3);
  assert(
    latency.every(({ ms, trusted }) => trusted && ms < 250),
    'Draft presses must update the actual row within 250ms',
  );
  await save('press-latency.json', latency);
  await cdp('screenshot', route, path.join(output, 'drafts.png'));
  await save('reload.json', JSON.parse(await cdp('reload', route)));
  await save('after-document-reload.json', { reloaded: true });
  const reloadUntil = Date.now() + 30000;
  while (!(await read()).approve?.includes('2 confirmed, 1 skipped')) {
    assert(Date.now() < reloadUntil, 'Drafts did not survive reload');
  }
  await cdp('click', route, selector('criterion-undo-AC-3'));
  assert((await read()).approve.includes('2 confirmed, 0 skipped'));
  await cdp('click', route, selector('criterion-skip-AC-3'));
  await save('drafts-after-reload-and-undo.json', await read());
  await cdp('click', route, selector('gate-approve'));
  await cdp('click', route, selector('gate-approve'));
  const savedUntil = Date.now() + 30000;
  while (!store.getRun(run.id).decisions[0].resolvedAt || fixture.suppressedResumes() !== 1) {
    const refusal = events.find(
      (event) => event.responseTo === 'run.resolveDecision' && event.ok === false,
    );
    if (refusal) throw new Error('Approval refused: ' + JSON.stringify(refusal.error));
    assert(Date.now() < savedUntil, 'Approval did not reach the actual receipt writer');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const saved = store.getRun(run.id);
  assert.notEqual(saved.status, 'failed', 'The isolated receipt proof must not start a workflow');
  assert.equal(saved.agentContexts?.length ?? 0, 0, 'No worker may be launched');
  assert.equal(
    fixture.suppressedResumes(),
    1,
    'The supported no-dispatch boundary must own resume',
  );
  assert.equal(saved.claimOverrideReceipts.length, 1);
  assert.equal(saved.claimOverrideReceipts[0].claimId, 'AC-3');
  assert(saved.decisions[0].evidenceAttestation.reason.includes('AC-2: Confirmed in code review.'));
  assert(saved.decisions[0].evidenceAttestation.reason.includes('AC-4: Confirmed in code review.'));
  assert(saved.decisions[0].evidenceAttestation.reason.includes('One configuration location.'));
  assert.equal(saved.visualJudgmentReceipts?.length ?? 0, 0);
  await save('durable-readback.json', {
    runId: saved.id,
    engineResumeSuppressed: fixture.suppressedResumes(),
    workerContexts: saved.agentContexts?.length ?? 0,
    overrideReceipts: saved.claimOverrideReceipts,
    attestation: saved.decisions[0].evidenceAttestation,
    decision: {
      resolvedAt: saved.decisions[0].resolvedAt,
      resolvedAction: saved.decisions[0].resolvedAction,
    },
  });
  assert.equal(events.filter(({ method }) => method === 'run.overrideClaim').length, 1);
  assert.equal(events.filter(({ method }) => method === 'run.resolveDecision').length, 1);
  assert(
    !events.some(({ method }) =>
      /^(slot\.refresh|fleet\.refreshSlots|run\.(replay|cancel|reviewVisualClaim)|dispatch\.(?!queue\.list))/.test(
        method ?? '',
      ),
    ),
  );
  releaseReplies();
  await cdp('screenshot', route, path.join(output, 'approval.png'));
}
