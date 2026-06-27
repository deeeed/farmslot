import assert from 'node:assert/strict';
import test from 'node:test';

import { COMPANION_DEMO_BANNER_TEXT, isCompanionDemoBannerEnabled } from './demo-banner';

test('companion demo banner is off unless EXPO_PUBLIC_FARMSLOT_DEMO_BANNER=1', () => {
  assert.equal(isCompanionDemoBannerEnabled({}), false);
  assert.equal(isCompanionDemoBannerEnabled({ EXPO_PUBLIC_FARMSLOT_DEMO_BANNER: '0' }), false);
  assert.equal(isCompanionDemoBannerEnabled({ EXPO_PUBLIC_FARMSLOT_DEMO_BANNER: '1' }), true);
});

test('companion demo banner copy is distinct from command center', () => {
  assert.equal(COMPANION_DEMO_BANNER_TEXT, 'FARMSLOT DEMO: MOBILE OPERATOR MONITORING');
  assert.ok(!COMPANION_DEMO_BANNER_TEXT.includes('PARALLEL RUN'));
});