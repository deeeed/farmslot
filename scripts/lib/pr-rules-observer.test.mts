// The e2e observer's assertion on recorded notice sequences: only a notice after mark() counts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { observePRRules } from './pr-rules-observer.mjs';

const notice = {
  event: 'resource.changed',
  payload: { changes: [{ key: { family: 'pr-automation', scope: 'farm' } }] },
};
/** The part of a prRules.list answer these checks read. */
interface Rules {
  submissions: string[];
}

/** A connection whose prRules.list answers the current store state, or fails when told to. */
function connection() {
  let handler: ((event: { event: string; payload?: unknown }) => void) | undefined;
  let state: Rules = { submissions: [] };
  let failure: Error | undefined;
  let reads = 0;
  return {
    reads: () => reads,
    set: (submissions: string[]) => {
      state = { submissions };
    },
    fail: (error: Error) => {
      failure = error;
    },
    emit: () => handler?.(notice),
    onEvent(next: (event: { event: string; payload?: unknown }) => void) {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
    call<T>(): Promise<T> {
      reads += 1;
      return failure ? Promise.reject(failure) : Promise.resolve(state as T);
    },
  };
}
const hasSubmission = (state: Rules) => state.submissions.includes('submission');

test('notices only before the action do not prove the second client was told', async () => {
  const gateway = connection();
  const observer = observePRRules<Rules>(gateway, 200);
  gateway.emit(); // setup write
  await observer.mark();
  gateway.set(['submission']); // the action commits, and its notice never arrives
  await assert.rejects(observer.expect(hasSubmission, 'told'), /told/);
});

test('a notice after the action passes', async () => {
  const gateway = connection();
  const observer = observePRRules<Rules>(gateway, 200);
  gateway.emit();
  await observer.mark();
  gateway.set(['submission']);
  gateway.emit();
  await observer.expect(hasSubmission, 'told');
});

test('a failed read after the action fails with its error', async () => {
  const gateway = connection();
  const observer = observePRRules<Rules>(gateway, 200);
  await observer.mark();
  gateway.fail(new Error('socket closed'));
  gateway.emit();
  await assert.rejects(observer.expect(hasSubmission, 'told'), /told: socket closed/);
});

test('notices after expect() start no reads', async () => {
  const gateway = connection();
  const observer = observePRRules<Rules>(gateway, 200);
  await observer.mark();
  gateway.set(['submission']);
  gateway.emit();
  await observer.expect(hasSubmission, 'told');
  const reads = gateway.reads();
  gateway.emit(); // a cleanup write
  assert.equal(gateway.reads(), reads);
});
