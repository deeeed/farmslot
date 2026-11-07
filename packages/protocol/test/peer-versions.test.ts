import assert from 'node:assert/strict';
import test from 'node:test';

import { peerVersionCompatibility, type PeerVersionDeclaration } from '../src/peer-versions.js';

const declaration = (
  protocolVersion: string,
  runtimeVersion = '0.43.0',
): PeerVersionDeclaration => ({
  protocolVersion,
  minimumProtocolVersion: '0.76.0',
  runtimeVersion,
  minimumRuntimeVersion: '0.42.0',
});

for (const [gateway, node] of [
  ['0.76.0', '0.77.0'],
  ['0.77.0', '0.76.0'],
]) {
  test(`compatible node ${node} and gateway ${gateway} satisfy both declared floors`, () => {
    assert.deepEqual(peerVersionCompatibility(declaration(gateway), declaration(node)), {
      status: 'compatible',
      compatible: true,
    });
  });
}

test('newer protocol and runtime minors or majors do not imply a break', () => {
  assert.equal(
    peerVersionCompatibility(declaration('0.79.0', '0.42.0'), declaration('1.0.0', '0.44.0'))
      .compatible,
    true,
  );
});

test('diagnostic peer labels cannot change version comparisons', () => {
  const local = declaration('0.79.0');
  const peer = { ...declaration('0.76.0'), minimumProtocolVersion: '0.79.0' };
  assert.equal(peerVersionCompatibility(local, peer, 'service', 'service').compatible, true);
});

for (const side of ['local', 'peer'] as const) {
  test(`${side}'s declared protocol break refuses with the actual version and minimum`, () => {
    const local = declaration('0.77.0');
    const peer = declaration('0.76.0');
    (side === 'local' ? local : peer).minimumProtocolVersion = '0.78.0';
    const result = peerVersionCompatibility(local, peer, 'gateway', 'node');
    assert.equal(result.status, 'incompatible');
    assert.equal(result.compatible, false);
    assert.match(
      result.reason!,
      /protocol incompatibility: .*0\.7[67]\.0.*declared minimum 0\.78\.0/,
    );
  });
}

test('runtime support is symmetric and refuses only an unmet runtime floor', () => {
  const local = declaration('0.79.0', '0.42.0');
  const peer = { ...declaration('0.80.0', '0.44.0'), minimumRuntimeVersion: '0.43.0' };
  const result = peerVersionCompatibility(local, peer, 'gateway', 'node');
  assert.equal(result.status, 'incompatible');
  assert.match(result.reason!, /runtime incompatibility: gateway 0\.42\.0.*minimum 0\.43\.0/);
});

for (const [gateway, node] of [
  ['0.42.0', '0.43.0'],
  ['0.43.0', '0.42.0'],
]) {
  test(`runtime ${node} node and ${gateway} gateway accept a newer minor in either direction`, () => {
    assert.equal(
      peerVersionCompatibility(declaration('0.79.0', gateway), declaration('0.79.0', node))
        .compatible,
      true,
    );
  });
}

test('missing legacy declarations are unverified and do not invent a break', () => {
  const result = peerVersionCompatibility(declaration('0.79.0'), { protocolVersion: '0.77.0' });
  assert.equal(result.status, 'unverified');
  assert.equal(result.compatible, undefined);
});

test('a known floor still excludes an older legacy peer', () => {
  const result = peerVersionCompatibility(declaration('0.79.0'), { protocolVersion: '0.75.0' });
  assert.equal(result.status, 'incompatible');
  assert.match(result.reason!, /0\.75\.0.*0\.76\.0/);
});

test('malformed supplied declarations name the invalid field without echoing its value', () => {
  const result = peerVersionCompatibility(declaration('0.79.0'), {
    ...declaration('0.80.0'),
    minimumProtocolVersion: 'not-a-release',
  });
  assert.equal(result.status, 'invalid');
  assert.match(result.reason!, /peer.minimumProtocolVersion/);
  assert.doesNotMatch(result.reason!, /not-a-release/);
});
