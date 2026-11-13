// A second client in the PR rule e2e scripts: on every `pr-automation` change it reads the rules
// with prRules.list, as Command Center and Companion do. Only reads started after `mark()` count.
import assert from 'node:assert/strict';

import type {
  PRRulesListResult,
  ResourceChangedPayload,
} from '../../packages/protocol/src/index.js';

export interface PRRulesObserverConnection {
  onEvent(handler: (event: { event: string; payload?: unknown }) => void): () => void;
  call<T>(method: string, params?: unknown): Promise<T>;
}

interface NoticeRead<State> {
  counted: boolean;
  state?: State;
  error?: Error;
  done: Promise<void>;
}

export function observePRRules<State = PRRulesListResult>(
  observer: PRRulesObserverConnection,
  waitMs = 5_000,
) {
  const reads: NoticeRead<State>[] = [];
  let counting = false;
  const stop = observer.onEvent((event) => {
    if (
      event.event !== 'resource.changed' ||
      !(event.payload as ResourceChangedPayload).changes.some(
        (change) => change.key.family === 'pr-automation',
      )
    )
      return;
    const read: NoticeRead<State> = { counted: counting, done: Promise.resolve() };
    // A failed read is kept and fails `expect` with its error.
    read.done = observer.call<State>('prRules.list').then(
      (state) => {
        read.state = state;
      },
      (error: unknown) => {
        read.error = error instanceof Error ? error : new Error(String(error));
      },
    );
    reads.push(read);
  });
  const matched = (predicate: (state: State) => boolean) =>
    reads.some((read) => read.counted && read.state && predicate(read.state));
  return {
    /** Call after the setup writes and before the action under test. */
    async mark(): Promise<void> {
      // A round trip on the observer socket lets notices of earlier writes land uncounted.
      await observer.call<State>('prRules.list');
      counting = true;
    },
    /** A read caused by a notice after `mark()` shows the change; stops observing. */
    async expect(predicate: (state: State) => boolean, label: string): Promise<void> {
      for (let waited = 0; !matched(predicate) && waited < waitMs; waited += 50)
        await new Promise((resolve) => setTimeout(resolve, 50));
      stop();
      await Promise.all(reads.map((read) => read.done));
      const failed = reads.find((read) => read.counted && read.error);
      assert(!failed, `${label}: ${failed?.error?.message}`);
      assert(matched(predicate), label);
    },
    stop,
  };
}
