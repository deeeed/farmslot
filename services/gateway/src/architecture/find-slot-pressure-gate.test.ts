import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Structural ratchet for MANUAL-000109: every FIND_SLOT early return that
// binds a slot for a FRESH worker launch must run the explicit-slot pressure
// admission gate (assertEngineBoundSlotPressureAdmitted) before any
// updateRun/claim/reset/kill. Warm-session and nudge reuse also have separate
// delivery-boundary gates immediately before their prompt sends; the main
// scored path is gated by dispatchPreview's decision check upstream.
//
// If this test fails after an edit to find-slot-step.ts, a claim path was
// added, removed, or reordered: re-audit the new shape against the gate
// placement rules above and update the expectations deliberately.

const SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../run-engine/find-slot-step.ts'),
  'utf-8',
);

function callLines(needle: string): number[] {
  return SOURCE.split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.includes(needle) && !line.trimStart().startsWith('*'))
    .map(({ index }) => index);
}

test('every slot binding in FIND_SLOT is pressure-gated before its claim', () => {
  const gateDefinition = 'async function assertEngineBoundSlotPressureAdmitted';
  assert.ok(SOURCE.includes(gateDefinition), 'gate helper missing');

  const gates = callLines('await assertEngineBoundSlotPressureAdmitted(');
  const claims = callLines('await claimSelectedSlot(');

  // Exactly eight gated binding families: warm-session reuse, wizard nudge,
  // freshReuse wizard-shortcut, held-slot affinity reuse, decision-card
  // nudge, decision-card fresh, decision-card pick, no-suitable-slot pick.
  // The main scored path is gated upstream by dispatchPreview's decision
  // check. If this count changes, a binding path was added, removed, or
  // reordered: re-audit gate placement before updating the expectation.
  assert.equal(gates.length, 8, `expected exactly 8 gate call sites, found ${gates.length}`);

  // Claim census: warm, wizard nudge, freshReuse fence+consume, affinity,
  // decision-card nudge, decision-card fresh fence+consume, decision-card
  // pick, no-suitable pick, main scored path.
  assert.equal(
    claims.length,
    11,
    `claimSelectedSlot call-site count changed (${claims.length}); audit the new/removed path for the pressure gate before updating this expectation`,
  );

  // Every gate precedes its claim in source order within the same branch.
  for (const gateLine of gates) {
    const followingClaim = claims.find((line) => line > gateLine && line - gateLine <= 40);
    assert.ok(
      followingClaim,
      `gate at line ${gateLine} has no claim within its branch — dead gate or reordered flow`,
    );
  }
});

test('nudge delivery is pressure-gated immediately before the send', () => {
  const nudgeSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../methods/dispatch/nudge.ts'),
    'utf-8',
  );
  const eligibility = nudgeSource.indexOf('verifyBranchAffinityNudgeStillEligible(');
  const gate = nudgeSource.indexOf('await enforceDispatchPressureGate({');
  const send = nudgeSource.indexOf('await sendRunnerInstructionSafely(');
  assert.ok(eligibility > 0 && gate > 0 && send > 0, 'anchors missing in nudge.ts');
  assert.ok(eligibility < gate, 'gate must run after the eligibility re-check');
  assert.ok(gate < send, 'gate must run before the irreversible nudge send');
  // Consumption at the delivery boundary uses the same durable persist path.
  assert.ok(
    nudgeSource.includes("persistRunNow(updateRun(runId, patch), 'pressure-override-consumption')"),
    'nudge gate must persist override consumption durably',
  );
});

test('warm-session handoff is pressure-gated immediately before retained delivery', () => {
  const warmSource = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../methods/dispatch/warm-session-handoff.ts',
    ),
    'utf-8',
  );
  const gate = warmSource.indexOf('await enforceDispatchPressureGate({');
  const delivery = warmSource.indexOf('await deliverPromptWithRetainedFallback(');
  assert.ok(gate > 0 && delivery > 0, 'warm handoff gate/delivery anchors missing');
  assert.ok(gate < delivery, 'warm handoff gate must precede retained delivery');
  assert.ok(
    warmSource.includes("persistRunNow(updateRun(runId, patch), 'pressure-override-consumption')"),
    'warm handoff gate must persist override consumption durably',
  );
});

test('fresh dispatch rechecks pressure before every runner effect path', () => {
  const executeSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../methods/dispatch/execute.ts'),
    'utf-8',
  );
  const effects = [
    ["step('clean', 'Cleaning pane...')", 'pane cleanup'],
    ['await attemptRepeatReviewResume(', 'review-session resume'],
    ['await respawnRoleWindowWithCommand(', 'role-window launch'],
    ['await runLaunchPreludeAndSend(', 'send-keys launch'],
    ['await sendRunnerPostLaunchPrompt(', 'post-launch prompt'],
  ] as const;
  for (const [needle, label] of effects) {
    const effect = executeSource.indexOf(needle);
    const gate = executeSource.lastIndexOf('await runPressureGate();', effect);
    assert.ok(effect > 0 && gate > 0, `${label} gate/effect anchors missing`);
    assert.ok(effect - gate < 1_200, `${label} has no nearby final pressure gate`);
  }
});

test('the common scored path durably consumes the client preview identity before slot bind', () => {
  const refresh = SOURCE.indexOf(
    'const refreshedPreviewRef = refreshedAdmissionRefForAdmittedPreview(\n    run.pressureAdmissionRef,\n    result.pressureAdmission,\n  );',
  );
  const persist = SOURCE.indexOf(
    'updateRun(runId, { pressureAdmissionRef: refreshedPreviewRef });',
    refresh,
  );
  const consume = SOURCE.indexOf(
    'await consumeRunPressureAdmissionRef(runId, getRun(runId) ?? run);\n  const slotId = result.preview.slotId;',
  );
  assert.ok(refresh > 0, 'scored path must refresh an admitted generation rotate');
  assert.ok(
    persist > refresh,
    'scored path must persist the refreshed preview identity after computing it',
  );
  assert.ok(
    consume > persist,
    'scored path must consume the validated ref immediately before updateRun(slotId)/claim',
  );
  assert.ok(
    SOURCE.includes("await persistRunNow(updated, 'pressure-admission-ref-consumption')"),
    'preview identity consumption must be durable before a slot claim',
  );
});

test('engine-bound slot binds refresh an admitted generation rotate before consume', () => {
  const start = SOURCE.indexOf('async function assertEngineBoundSlotPressureAdmitted');
  const end = SOURCE.indexOf('\nexport function refreshedAdmissionRefForAdmittedPreview');
  assert.ok(start > 0 && end > start, 'engine-bound pressure gate helper missing');
  const body = SOURCE.slice(start, end);
  assert.ok(
    body.includes('refreshedAdmissionRefForAdmittedPreview('),
    'engine-bound binds must reuse the admitted-preview refresh helper',
  );
  assert.ok(
    body.includes('updateRun(runId, { pressureAdmissionRef: refreshedPreviewRef })'),
    'engine-bound binds must persist the refreshed preview identity',
  );
  assert.ok(
    body.includes('await consumeRunPressureAdmissionRef(runId, getRun(runId) ?? run)'),
    'engine-bound binds must consume the refreshed identity',
  );
});
