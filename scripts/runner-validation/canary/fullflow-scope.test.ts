import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fullflowScopeAudit } from './fullflow-scope.mjs';

test('scope audit filters sessions and boundaries, retaining outside reads and writes as observations', () => {
  const roots = { slot: '/private/tmp/stack/slots/fix', task: '/tmp/task', fixture: '/private/tmp/stack', home: '/tmp/stack/home' };
  const source = (cwd: string, command: string) => ({ file: cwd + '.jsonl', text: [
    { type: 'session', cwd },
    { timestamp: 'now', message: { content: [{ type: 'toolCall', name: 'bash', arguments: { command } }] } },
  ].map((record) => JSON.stringify(record)).join('\n') });
  const audit = fullflowScopeAudit([
    source(roots.slot, 'cat /tmp/stack/slots/fix/a /tmp/task/x /tmp/stack/pin /outside/read; echo x > /outside/write; cat /tmp/stack-other/x ~/inside ../../../../../outside; node -e "console.log(/^5$/.test(x))"'),
    source('/tmp/stack/slots/qa', 'cat /other-case'),
  ], roots);
  assert.equal(audit.observationOnly, true);
  assert.equal(audit.toolCalls, 1);
  assert.deepEqual(audit.findings.map((item) => item.path), ['/outside/read', '/outside/write', '/tmp/stack-other/x', '/outside']);
});

test('native file tool paths are audited without treating output text as tool activity', () => {
  const audit = fullflowScopeAudit([{ file: 'native.jsonl', text: [
    { type: 'tool.started', tool: { name: 'read', input: { path: '/support/wrapper.mjs' } } },
    { type: 'text.delta', text: 'cat /not-a-tool-call' },
  ].map((record) => JSON.stringify(record)).join('\n') }], {
    slot: '/tmp/stack/slot', fixture: '/tmp/stack', home: '/tmp/stack/home',
  });
  assert.deepEqual(audit.findings.map((item) => item.path), ['/support/wrapper.mjs']);
});
