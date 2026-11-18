import { buildRecipeInvocationTree } from '../src/core/flow.js';
import type { ResolvedLibraryRecipe } from '../src/core/library.js';

export const inner = {
  proofTargets: [{ id: 'AC-1', claim: 'Observed fixture output is OK', proofMode: 'state' }],
  workflow: {
    entry: 'observe',
    nodes: {
      observe: {
        action: 'command',
        intent: 'Observe fixture output',
        cmd: 'printf OK',
        next: 'read',
      },
      read: {
        action: 'assert_output',
        intent: 'Read shared state',
        source: 'observe',
        stream: 'stdout',
        contains: 'OK',
        proves: ['AC-1'],
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    },
  },
};
export const unit = {
  workflow: {
    entry: 'nested',
    teardown: 'release',
    nodes: {
      nested: { action: 'call', ref: 'fixture.inner', intent: 'Inspect state', next: 'leaf' },
      leaf: { action: 'wait', intent: 'Validate state', next: 'done' },
      done: { action: 'end', status: 'pass' },
      release: { action: 'wait', intent: 'Release nested resources', next: 'clean' },
      clean: { action: 'end', status: 'pass' },
    },
  },
};
export const root = {
  title: 'Composed flow fixture',
  workflow: {
    entry: 'first',
    teardown: 'cleanup',
    nodes: {
      first: { action: 'call', ref: 'fixture.unit', intent: 'First invocation', next: 'second' },
      second: { action: 'call', ref: 'fixture.unit', intent: 'Repeated invocation', next: 'pick' },
      pick: {
        action: 'switch',
        intent: 'Choose a branch',
        cases: { yes: 'accept', no: 'reject' },
        default: 'reject',
      },
      accept: { action: 'wait', intent: 'Accept state', next: 'done' },
      reject: { action: 'wait', intent: 'Reject state', next: 'reject_extra' },
      reject_extra: { action: 'wait', intent: 'Explain rejection', next: 'done' },
      done: { action: 'end', status: 'pass' },
      cleanup: { action: 'wait', intent: 'Clean up root resources', next: 'clean' },
      clean: { action: 'end', status: 'pass' },
    },
  },
};

export function fixtureTree() {
  const recipes = new Map<string, ResolvedLibraryRecipe>();
  for (const [ref, document] of [
    ['fixture.inner', inner],
    ['fixture.unit', unit],
  ] as const) {
    recipes.set(ref, {
      ref,
      document,
      source: 'fixture',
      file: ref + '.recipe.json',
      path: '/fixture/' + ref,
      provenance: { kind: 'library', trust: 'trusted' },
      shadows: [],
    });
  }
  return buildRecipeInvocationTree({ root, rootRef: 'fixture.root', recipes });
}
