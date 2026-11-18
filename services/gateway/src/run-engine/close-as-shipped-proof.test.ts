import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run, RunDecision } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import type { FinalizeStepContext } from './finalize-step.js';

await import('../runtime/mock-pty.test-support.js');

// Close as Shipped used to record whatever PR number the run already carried,
// skipping the merged-PR proof whenever that field was set. An earlier gate
// persists the probe's answer and never replaces it, so the field can name a
// PR that merged an OLDER head: the run then completes as published against a
// PR that does not contain the head being closed.
const packageHead = 'a'.repeat(40);
const stalePrNumber = 388;
const shippedPrNumber = 400;

const probeCalls: { prNumber: number | undefined; headSha: string | undefined }[] = [];
let probeResult: number | null = shippedPrNumber;
let probeError: Error | undefined;
// How many of the next probe calls fail; the rest answer normally. The read is
// retried once before a person is involved.
let probeErrorsRemaining = Number.POSITIVE_INFINITY;
let savedLinkIsStale = false;
let staleCheckError: Error | undefined;
const staleChecks: (string | undefined)[] = [];
const persisted: number[] = [];
// The run finalize was last driven with, so a case that ends in a refusal can
// still inspect the state the hold left behind.
let heldRunId: string | undefined;

const linkage = await import('../integrations/pr-linkage.js');
mock.module('../integrations/pr-linkage.js', {
  namedExports: {
    ...linkage,
    findMergedPRNumber: async (
      run: { prNumber?: number },
      _repo: string,
      headSha?: string,
      options?: { onProbeError?: 'null' | 'throw' },
    ) => {
      probeCalls.push({ prNumber: run.prNumber, headSha });
      if (probeError && probeErrorsRemaining > 0) {
        probeErrorsRemaining -= 1;
        if (options?.onProbeError === 'throw') throw probeError;
        return null;
      }
      return probeResult;
    },
    mergedLinkIsStale: async (_run: unknown, _repo: string, headSha?: string) => {
      staleChecks.push(headSha);
      if (staleCheckError) throw staleCheckError;
      return savedLinkIsStale;
    },
    // Delegates, so the assertions see the real persisted state.
    persistRunPrNumber: async (runId: string, prNumber: number) => {
      persisted.push(prNumber);
      await linkage.persistRunPrNumber(runId, prNumber);
    },
  },
});

const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { latestResolvedHumanGateDecision } = await import('./decision-replay.js');
const { executeFinalizeStep } = await import('./finalize-step.js');
const { deleteTestRunIfPresent, makeReadyGatePackage } = await import('./test-fixtures.js');
// The real link recompute, not a stub: clearing the number is only half of
// making the run adoptable.
const { dropRunPrLink, refreshRunLinks } = await import('./run-links.js');

const closeAsShipped: RunDecision = {
  id: 'publication',
  type: 'engine_human_gate',
  title: 'Publication gate',
  description: '',
  actions: [],
  createdAt: '2026-11-18T00:00:00Z',
  resolvedAt: '2026-11-18T00:01:00Z',
  resolvedAction: 'close-as-shipped',
};

const finalizeWithoutCiRepo = async (t: { after: (fn: () => void) => void }) =>
  finalize(t, { ci: undefined });

const finalize = async (
  t: { after: (fn: () => void) => void },
  projectJson: Record<string, unknown> = { default_branch: 'main', ci: { repo: 'owner/repo' } },
  overrides?: { ticketOrPr?: string; links?: Run['links']; realRunLinks?: boolean },
) => {
  probeCalls.length = 0;
  persisted.length = 0;
  staleChecks.length = 0;
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'generic-project',
    ticketOrPr: overrides?.ticketOrPr ?? 'TAT-4644',
    branch: 'fix/reused',
  });
  heldRunId = run.id;
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'completing',
    slotId: 'close-as-shipped-fixture',
    prNumber: stalePrNumber,
    decisions: [closeAsShipped],
    ...(overrides?.links ? { links: overrides.links } : {}),
  });
  const context: FinalizeStepContext = {
    broadcastFn: () => {},
    latestResolvedHumanGateDecision,
    loadProjectVarsOrNull: async () => ({ projectJson }),
    readPreparedPackage: async () => makeReadyGatePackage({ headSha: packageHead }),
    refreshRunLinks: overrides?.realRunLinks === true ? refreshRunLinks : async () => {},
    ...(overrides?.realRunLinks === true ? { dropRunPrLink } : { dropRunPrLink: async () => {} }),
    probeRetryDelayMs: 0,
    stepPartialIO: new Map(),
  };
  await executeFinalizeStep(run.id, context);
  return run;
};

test('close-as-shipped re-proves a saved PR number against the head it is closing', async (t) => {
  probeResult = shippedPrNumber;
  probeError = undefined;
  probeErrorsRemaining = Number.POSITIVE_INFINITY;
  savedLinkIsStale = false;
  staleCheckError = undefined;
  const run = await finalize(t);
  assert.deepEqual(
    probeCalls,
    [{ prNumber: stalePrNumber, headSha: packageHead }],
    'the probe must run even when the run already carries a PR number',
  );
  assert.equal(getRun(run.id)?.prNumber, shippedPrNumber);
  assert.deepEqual(persisted, [shippedPrNumber]);
  assert.equal(
    getRun(run.id)?.engineState?.publishGate?.publicationStatus,
    'published_ready',
    'the proved PR is the one the run is published against',
  );
});

test('close-as-shipped claims no publication when nothing proves it shipped', async (t) => {
  probeResult = null;
  probeError = undefined;
  probeErrorsRemaining = Number.POSITIVE_INFINITY;
  savedLinkIsStale = false;
  staleCheckError = undefined;
  const run = await finalize(t);
  assert.equal(probeCalls.length, 1);
  assert.deepEqual(persisted, []);
  assert.notEqual(
    getRun(run.id)?.engineState?.publishGate?.publicationStatus,
    'published_ready',
    'a stale saved number must not become a publication claim',
  );
});

// adopt-published-pr refuses while the run links a different PR, so leaving an
// unproven merged number behind does not just mislabel the run: it stops the
// operator recording what actually shipped.
test('close-as-shipped clears an unproven merged link so the run stays adoptable', async (t) => {
  probeResult = null;
  probeError = undefined;
  probeErrorsRemaining = Number.POSITIVE_INFINITY;
  savedLinkIsStale = true;
  staleCheckError = undefined;
  const run = await finalize(t);
  assert.deepEqual(staleChecks, [packageHead]);
  assert.equal(getRun(run.id)?.prNumber, undefined);
  assert.notEqual(getRun(run.id)?.engineState?.publishGate?.publicationStatus, 'published_ready');
});

// Clearing the number is only half of it. `adopt-published-pr` also refuses a
// run whose `links` still name another PR, and the ordinary link recompute
// keeps the old list whenever the new one comes back empty — which is exactly
// what a backlog or GitHub-issue ticket recomputes to once the number is gone.
test('close-as-shipped drops the stale PR link, not just the number', async (t) => {
  probeResult = null;
  probeError = undefined;
  probeErrorsRemaining = Number.POSITIVE_INFINITY;
  savedLinkIsStale = true;
  staleCheckError = undefined;
  const staleLink = `https://github.com/owner/repo/pull/${stalePrNumber}`;
  const issueLink = 'https://github.com/owner/repo/issues/2290';
  const run = await finalize(
    t,
    { default_branch: 'main', ci: { repo: 'owner/repo' } },
    {
      ticketOrPr: 'owner/repo#2290',
      links: [
        { label: 'PR', url: staleLink },
        { label: 'Issue', url: issueLink },
      ],
      realRunLinks: true,
    },
  );
  assert.equal(getRun(run.id)?.prNumber, undefined);
  assert.equal(
    getRun(run.id)?.links?.some((link) => link.url === staleLink),
    false,
    'adopt-published-pr refuses while the run still links PR #388, so the operator cannot record what shipped',
  );
  // Only the PR row goes. Without a prNumber, computeRunLinks cannot regenerate
  // a lone issue link, so wiping the whole list would lose the ticket too.
  assert.equal(
    getRun(run.id)?.links?.some((link) => link.url === issueLink),
    true,
    'the ticket link is not the stale one and nothing recomputes it back',
  );
});

test('close-as-shipped keeps a live PR link that is not a stale merge', async (t) => {
  probeResult = null;
  probeError = undefined;
  probeErrorsRemaining = Number.POSITIVE_INFINITY;
  savedLinkIsStale = false;
  staleCheckError = undefined;
  const run = await finalize(t);
  assert.equal(
    getRun(run.id)?.prNumber,
    stalePrNumber,
    'an open saved PR is live publication state, not stale discovery linkage',
  );
});

// Without ci.repo there is nothing to prove a shipment against, so a saved
// number stays a link and never becomes a publication claim.
test('close-as-shipped makes no publication claim without a ci repo', async (t) => {
  probeResult = shippedPrNumber;
  probeError = undefined;
  probeErrorsRemaining = Number.POSITIVE_INFINITY;
  savedLinkIsStale = false;
  staleCheckError = undefined;
  const run = await finalizeWithoutCiRepo(t);
  assert.deepEqual(probeCalls, []);
  assert.equal(getRun(run.id)?.prNumber, stalePrNumber);
  assert.notEqual(
    getRun(run.id)?.engineState?.publishGate?.publicationStatus,
    'published_ready',
    'a saved number with nothing to prove it against is not a shipment',
  );
});

// Unknown is not "nothing shipped": settling the run on an unreachable probe is
// how a wrong attribution becomes permanent.
//
// The refusal has to be RUN_GATE_NOT_READY, not an ordinary failure. An
// ordinary error fails finalize, and terminal cleanup can release the slot —
// after which replay cannot reclaim it and adoption still refuses a run whose
// saved number names a different PR, so "retryable" would be retryable in name
// only.
test('close-as-shipped holds the run when the probe cannot answer', async (t) => {
  probeResult = null;
  probeError = new Error('merged-PR probe timed out after 15000ms');
  savedLinkIsStale = false;
  staleCheckError = undefined;
  const error = await finalize(t).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof GatewayMethodError, `expected a gate refusal, got ${String(error)}`);
  assert.equal(error.code, 'RUN_GATE_NOT_READY');
  assert.match(error.message, /probe timed out/);
  assert.equal(probeCalls.length, 2, 'the read is retried once before a person is involved');
  // The message is what becomes run.error and the decision card's description,
  // so the retry has to be named there and not only in `userAction`. Without it
  // the run sits in needs-decision with no visible way back (lead, 11-18).
  assert.match(error.message, /replay the finalize step/i);
  // A hold has to leave the run exactly as a finalize replay needs it. The
  // clear runs only after both reads answered, so the saved number stays.
  assert.equal(
    getRun(heldRunId!)?.prNumber,
    stalePrNumber,
    'a held probe must not clear the saved link on its way out',
  );
});

// A momentary GitHub failure is not a question for a person: the read is retried
// once, and a run whose second attempt answers completes without ever being
// held. The canary's interrupted-teardown case failed on a GraphQL 500 the
// recovery fixture did not answer (run 26c8347c), which is the same shape.
test('close-as-shipped retries a failed proof read before holding the run', async (t) => {
  probeResult = shippedPrNumber;
  probeError = new Error('gh: 502 Bad Gateway');
  probeErrorsRemaining = 1;
  savedLinkIsStale = false;
  staleCheckError = undefined;
  const run = await finalize(t);
  assert.equal(probeCalls.length, 2, 'one failure, then the answer');
  assert.equal(getRun(run.id)?.prNumber, shippedPrNumber);
  assert.equal(getRun(run.id)?.engineState?.publishGate?.publicationStatus, 'published_ready');
});

// The stale-link check is a second GitHub read on the same path, so it needs
// the same hold: a timeout there must not complete or fail the run either.
test('close-as-shipped holds the run when the stale-link read cannot answer', async (t) => {
  probeResult = null;
  probeError = undefined;
  probeErrorsRemaining = Number.POSITIVE_INFINITY;
  staleCheckError = new Error('prView failed: 502 Bad Gateway');
  const error = await finalize(t).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof GatewayMethodError, `expected a gate refusal, got ${String(error)}`);
  assert.equal(error.code, 'RUN_GATE_NOT_READY');
  assert.match(error.message, /502 Bad Gateway/);
  assert.equal(
    getRun(heldRunId!)?.prNumber,
    stalePrNumber,
    'a held stale-link read must not clear the saved link either',
  );
});
