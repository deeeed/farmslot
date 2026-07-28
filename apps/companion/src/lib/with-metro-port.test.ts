import assert from 'node:assert/strict';
import test from 'node:test';

const { updateMetroPortGradleProperties } = require('../../plugins/withMetroPort.cjs') as {
  updateMetroPortGradleProperties: (
    properties: Array<{ type: string; key?: string; value?: string }>,
    port?: number,
  ) => Array<{ type: string; key?: string; value?: string }>;
};

test('Metro config plugin removes stale native ports even when no replacement is configured', () => {
  const properties = [
    { type: 'property', key: 'reactNativeDevServerPort', value: '45102' },
    { type: 'property', key: 'other', value: 'kept' },
  ];

  assert.deepEqual(updateMetroPortGradleProperties(properties), [
    { type: 'property', key: 'other', value: 'kept' },
  ]);
  assert.deepEqual(updateMetroPortGradleProperties(properties, 65_535), [
    { type: 'property', key: 'other', value: 'kept' },
    { type: 'property', key: 'reactNativeDevServerPort', value: '65535' },
  ]);
});
