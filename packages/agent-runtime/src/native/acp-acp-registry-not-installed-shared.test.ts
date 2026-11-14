import assert from 'node:assert/strict';
import test from 'node:test';

import { createAcpAdapter } from './acp.js';
import { setup } from './acp.test-support.js';
const provider = 'ACP registry';

test(
  `${provider}, not installed: shared ACP contract emits text before turn completion`,
  { timeout: 10_000 },
  async () => {
    const f = setup();
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let done = false;
    const text: string[] = [];
    const adapter = createAcpAdapter({
      args: () => [],
      authMethod: 'cached_token',
      modes: ['default'],
    });
    const session = await adapter.start(f, (event) => {
      if (event.type === 'text.delta') {
        assert.equal(done, false);
        text.push(event.text ?? '');
      }
      if (event.type === 'turn.completed') {
        done = true;
        complete();
      }
    });
    try {
      await session.send('text', 'contract-command');
      await completed;
      assert.deepEqual(text, ['ANSWER']);
    } finally {
      await session.close();
      f.cleanup();
    }
  },
);
