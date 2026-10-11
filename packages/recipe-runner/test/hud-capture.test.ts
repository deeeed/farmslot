import assert from 'node:assert/strict';
import test from 'node:test';

import { createStandardUiAdapters, type UiActionTransport } from '../src/adapters/ui.js';
import type { ActionExecutionContext, ActionResult } from '../src/core/types.js';

for (const mode of ['direct', 'registered', 'recorder'] as const) {
  test(`HUD observations surround ${mode} capture and preserve registered artifact identity`, async () => {
    const events: string[] = [];
    const registered: NonNullable<ActionResult['artifacts']> = [];
    const context: ActionExecutionContext = {
      nodeId: 'capture',
      recipe: {},
      projectRoot: '/fixture',
      artifactsDir: '/fixture/proof',
      env: {},
      outputs: new Map(),
      getOutput: () => undefined,
      resolveProjectPath: (value) => value,
      resolveArtifactPath: (value) => value,
      getRunFileOffset: () => undefined,
      registerArtifact: (artifact) => {
        registered.push(artifact);
      },
      logger: { info() {}, warn() {}, error() {} },
      ...(mode === 'recorder'
        ? {
            captureRecordingSnapshot: async () => {
              events.push('capture');
              return { frame: 7 };
            },
          }
        : {}),
    };
    const transport: UiActionTransport = {
      async execute(_action, _node, active) {
        events.push('capture');
        const artifact = {
          path: 'capture.png',
          nodeId: active.nodeId,
          type: 'screenshot',
          metadata: { provider: 'fixture' },
        };
        active.registerArtifact(artifact);
        return mode === 'registered'
          ? { artifact }
          : { kind: 'ui-transport-result', control: { artifacts: [artifact] } };
      },
      async observe(refs) {
        assert.deepEqual(refs, ['ui.hud']);
        events.push('observe');
        return { observations: { 'ui.hud': { visible: true, intent: 'Capture the screen' } } };
      },
    };
    const adapter = createStandardUiAdapters({
      actions: ['ui.screenshot'],
      transport,
      captureHudEvidence: true,
    })[0]!;
    const result = await adapter.execute({ intent: 'Capture the screen' }, context);
    assert.deepEqual(events, ['observe', 'capture', 'observe']);
    const artifact = result.artifacts?.[0] ?? registered[0]!;
    assert.deepEqual(artifact.metadata?.hud, {
      before: { visible: true, intent: 'Capture the screen' },
      after: { visible: true, intent: 'Capture the screen' },
    });
    events.length = 0;
    await createStandardUiAdapters({ actions: ['ui.screenshot'], transport })[0]!.execute(
      {},
      context,
    );
    assert.deepEqual(events, ['capture']);
    transport.observe = async () => {
      throw new Error('HUD unavailable');
    };
    const failed = await adapter.execute({}, context);
    assert.deepEqual((failed.artifacts?.[0] ?? registered.at(-1)!).metadata?.hud, {
      before: { visible: false, reason: 'HUD unavailable' },
      after: { visible: false, reason: 'HUD unavailable' },
    });
    events.length = 0;
    context.signal = AbortSignal.abort(new Error('Capture cancelled'));
    await assert.rejects(adapter.execute({}, context), /Capture cancelled/);
    assert.deepEqual(events, []);
    const controller = new AbortController();
    context.signal = controller.signal;
    transport.observe = async () => {
      events.push('observe');
      controller.abort(new Error('Cancelled during HUD observation'));
      return { observations: { 'ui.hud': { visible: true, intent: 'Capture the screen' } } };
    };
    await assert.rejects(adapter.execute({}, context), /Cancelled during HUD observation/);
    assert.deepEqual(events, ['observe']);
  });
}
