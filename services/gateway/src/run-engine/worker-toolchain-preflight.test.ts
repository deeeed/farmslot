import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkToolchainObservation,
  parseToolchainObservation,
  type ToolchainObservation,
} from './worker-toolchain-preflight.js';

function observation(): ToolchainObservation {
  return {
    requirements: [
      { tool: 'node', range: 'v24.22.1', source: '.nvmrc' },
      { tool: 'node', range: '>=24.13.0', source: 'engines.node' },
      { tool: 'yarn', range: '^4.14.1', source: 'engines.yarn' },
    ],
    tools: {
      node: { version: 'v24.22.1' },
      yarn: { version: '4.14.1' },
      yarnNode: { version: 'v24.22.1' },
      ruby: {},
    },
  };
}

test('valid override Node with an older Yarn child is refused and names the exact cause', () => {
  const value = observation();
  value.tools.yarnNode = { version: 'v24.13.0' };
  const result = checkToolchainObservation(value, 'fixture-slot');
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /yarnNode resolved v24.13.0; expected v24.22.1 from .nvmrc/);
});

test('declared Ruby mismatch refuses; an undeclared Ruby is never required', () => {
  const value = observation();
  assert.equal(checkToolchainObservation(value, 'slot').status, 'verified');
  value.requirements.push({ tool: 'ruby', range: '3.3.1', source: 'selected pack toolchain pins' });
  value.tools.ruby = { version: '3.2.2' };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'mismatch');
});

test('a conflicting pack pin is observed even when product engines permit the runtime', () => {
  const value = observation();
  value.requirements.push({
    tool: 'node',
    range: '24.13.0',
    source: 'selected pack toolchain pins',
  });
  assert.match(
    checkToolchainObservation(value, 'slot').detail,
    /expected 24.13.0 from selected pack/,
  );
});

test('missing tools are observed mismatches, failed observations remain unverified', () => {
  const value = observation();
  value.tools.yarnNode = { unavailable: 'transport timed out' };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'unverified');
  value.tools.yarnNode = { missing: true };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'mismatch');
});

test('no Yarn version is invented when only Node is declared', () => {
  const value = observation();
  value.requirements = value.requirements.filter((entry) => entry.tool !== 'yarn');
  value.tools.yarn = { version: 'unversioned' };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'verified');
});

test('unknown aliases and noisy observations stay unverified', () => {
  const value = observation();
  value.requirements[0].range = 'lts/latest';
  assert.equal(checkToolchainObservation(value, 'slot').status, 'unverified');
  value.tools.node = { version: 'tool not ready' };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'unverified');
});

test('malformed probe responses are not accepted as typed observations', () => {
  assert.equal(parseToolchainObservation('{"requirements":[{}],"tools":{}}'), undefined);
  const value = observation();
  assert.deepEqual(parseToolchainObservation(JSON.stringify(value)), value);
});
