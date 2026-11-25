import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RawProjectJson } from '../../core/index.js';

import {
  checkPrepareArtifactReceipt,
  projectPinsPrepare,
  resolvePinnedProfile,
} from './pinned-prepare.js';

const BASE = '260bd3a5b20c3f9126510b7b71d0e5527f395b5d';
const REVISION = 'a'.repeat(40);

const mobile: RawProjectJson = {
  name: 'mobile',
  hooks: { artifact_check: 'bash runway-artifact-check.sh' },
  prepare: {
    default: 'ensure-js-runtime',
    profiles: {
      'ensure-js-runtime': { phases: ['git', 'deps', 'preflight'] },
      runtime: { phases: ['git', 'deps', 'preflight', 'health'] },
      full: { phases: ['git', 'deps', 'preflight', 'health'], pinned_kind: 'source' },
      attach: { phases: ['health'], requires: ['health_ok'], fallback: 'runtime' },
      runway: {
        phases: ['git', 'deps', 'preflight'],
        requires: ['artifact_available'],
        fallback: 'runtime',
        pinned_kind: 'runway',
      },
    },
    pinned_profiles: { ios: ['runway', 'full'], android: ['full'] },
  },
};

test('only projects with an artifact probe or pinned profiles take part', () => {
  assert.equal(projectPinsPrepare(mobile), true);
  assert.equal(
    projectPinsPrepare({ name: 'm', hooks: { artifact_check: 'probe' } }),
    true,
    'a probe without pinned_profiles still takes part, so its runs are refused, not run unpinned',
  );
  assert.equal(projectPinsPrepare({ name: 'extension', prepare: { profiles: {} } }), false);
  assert.equal(projectPinsPrepare({ name: 'core' }), false);
});

test('a pinned run gets the first listed profile for its platform', () => {
  assert.deepEqual(resolvePinnedProfile(mobile, 'ios'), { name: 'runway', kind: 'runway' });
  assert.deepEqual(
    resolvePinnedProfile(mobile, 'android'),
    { name: 'full', kind: 'source' },
    'Runway is iOS-only, so Android defaults to a source build',
  );
  const listed = { ...mobile, prepare: { ...mobile.prepare, pinned_profiles: ['full'] } };
  assert.deepEqual(resolvePinnedProfile(listed, 'web'), { name: 'full', kind: 'source' });
});

test('an explicit profile must be listed for the platform', () => {
  assert.deepEqual(resolvePinnedProfile(mobile, 'ios', 'full'), { name: 'full', kind: 'source' });
  assert.throws(
    () => resolvePinnedProfile(mobile, 'ios', 'attach'),
    /profile 'attach': it is not in prepare\.pinned_profiles for ios \(allowed: runway, full\)/,
  );
  assert.throws(
    () => resolvePinnedProfile(mobile, 'ios', 'runtime'),
    /profile 'runtime': it is not in prepare\.pinned_profiles/,
  );
  assert.throws(
    () => resolvePinnedProfile(mobile, 'android', 'runway'),
    /not in prepare\.pinned_profiles for android \(allowed: full\)/,
  );
});

test('a pinned run is refused when the project cannot say what to install', () => {
  assert.throws(
    () => resolvePinnedProfile({ name: 'm', hooks: { artifact_check: 'probe' } }, 'ios'),
    /declares artifact_check but no prepare\.pinned_profiles/,
  );
  assert.throws(
    () => resolvePinnedProfile(mobile, 'web'),
    /prepare\.pinned_profiles has no entry for platform 'web'/,
  );
});

const expected = { kind: 'runway' as const, baseSha: BASE, platform: 'ios' };
const receipt = (fields: Record<string, unknown>) =>
  JSON.stringify({
    status: 'ok',
    kind: 'runway',
    baseSha: BASE,
    runId: '41900351233',
    revision: REVISION,
    platform: 'ios',
    ...fields,
  });

test('a receipt that matches the run is the installed build', () => {
  assert.deepEqual(checkPrepareArtifactReceipt(receipt({}), expected), {
    kind: 'runway',
    baseSha: BASE,
    runId: '41900351233',
    revision: REVISION,
    platform: 'ios',
  });
});

test('a missing or malformed receipt fails prepare', () => {
  assert.throws(
    () => checkPrepareArtifactReceipt(null, expected),
    /wrote no prepare-artifact\.json/,
  );
  assert.throws(() => checkPrepareArtifactReceipt('{', expected), /is not a JSON receipt object/);
  assert.throws(() => checkPrepareArtifactReceipt('[]', expected), /is not a JSON receipt object/);
  assert.throws(
    () => checkPrepareArtifactReceipt(receipt({ status: 'maybe' }), expected),
    /status must be ok or failed/,
  );
});

test('a receipt must echo the run base and name a full revision', () => {
  assert.throws(
    () => checkPrepareArtifactReceipt(receipt({ baseSha: 'b'.repeat(40) }), expected),
    new RegExp(`installed for base ${'b'.repeat(40)}, not the run's start ${BASE}`),
  );
  assert.throws(
    () => checkPrepareArtifactReceipt(receipt({ revision: '41900351233' }), expected),
    /revision must be a full commit id/,
    'runRevision can fall back to the run id; that is not a revision',
  );
  assert.throws(
    () => checkPrepareArtifactReceipt(receipt({ runId: '' }), expected),
    /a runway receipt must name its run id/,
  );
});

test('a receipt of the wrong kind or platform is refused', () => {
  assert.throws(
    () => checkPrepareArtifactReceipt(receipt({ kind: 'source' }), expected),
    /receipt kind 'source' does not match profile kind 'runway'/,
  );
  assert.throws(
    () => checkPrepareArtifactReceipt(receipt({ platform: 'android' }), expected),
    /receipt platform 'android' does not match the slot platform 'ios'/,
  );
});

test('a refusal carries the harness reason on one line', () => {
  const reason =
    'Runway run 43209905420 rejected: yarn.lock differs from the base commit\nNext: mm-harness launch ios --build';
  assert.throws(
    () => checkPrepareArtifactReceipt(receipt({ status: 'failed', reason }), expected),
    (error: Error) => {
      assert.equal(
        error.message,
        `Pinned build refused: Runway run 43209905420 rejected: yarn.lock differs from the base commit; Next: mm-harness launch ios --build`,
      );
      return true;
    },
  );
  assert.throws(
    () => checkPrepareArtifactReceipt(receipt({ status: 'failed' }), expected),
    /Pinned build refused: the preflight gave no reason/,
  );
});

test('compatibility names the compatibility profile before the list is checked', () => {
  const aliased = {
    ...mobile,
    prepare: { ...mobile.prepare, compatibility_profile: 'full' },
  };
  assert.deepEqual(resolvePinnedProfile(aliased, 'ios', 'compatibility'), {
    name: 'full',
    kind: 'source',
  });
  assert.throws(
    () =>
      resolvePinnedProfile(
        { ...mobile, prepare: { ...mobile.prepare, compatibility_profile: 'runtime' } },
        'ios',
        'compatibility',
      ),
    /profile 'runtime': it is not in prepare\.pinned_profiles/,
  );
});
