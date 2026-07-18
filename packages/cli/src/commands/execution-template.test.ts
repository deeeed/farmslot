import assert from 'node:assert/strict';
import test from 'node:test';

import { assertAgentRuntimeExports } from './execution-template.js';

const completeModule = Object.fromEntries(
  [
    'createExecutionTemplate',
    'customTemplateSource',
    'lintExecutionTemplates',
    'listExecutionTemplates',
    'packageFlowTreeTemplateSource',
    'projectWorkerTemplateSource',
  ].map((name) => [name, () => undefined]),
);

type ValidatableModule = Parameters<typeof assertAgentRuntimeExports>[0];

test('a complete agent-runtime module passes export validation', () => {
  assertAgentRuntimeExports(completeModule as ValidatableModule);
});

test('a stale module missing exports fails with the rebuild guidance', () => {
  // The live-incident shape: the dist imports fine but predates the
  // execution-template exports — the loader must name the rebuild, not let a
  // later undefined-function call surface as a generic error.
  const stale = { ...completeModule };
  delete (stale as Record<string, unknown>).createExecutionTemplate;
  try {
    assertAgentRuntimeExports(stale as ValidatableModule);
    assert.fail('expected throw');
  } catch (err) {
    const e = err as Error & { code?: string; userAction?: string };
    assert.equal(e.code, 'AGENT_RUNTIME_UNAVAILABLE');
    assert.match(e.message, /missing exports: createExecutionTemplate/);
    assert.match(e.userAction ?? '', /yarn workspace @farmslot\/agent-runtime build/);
  }
});
