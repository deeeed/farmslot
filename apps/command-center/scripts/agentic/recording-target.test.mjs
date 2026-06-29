import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gatewayTokenSeedScript, resolveRecordingTarget } from './run-recipe.mjs';

// Regression: the recipe video recorder used to pick a window by the shared default
// title "Farmslot Command Center". That title belongs to every slot's UI and the
// operator's own browser tabs, so it captured the wrong slot (e.g. ff-2's recipe video
// showed mme-5). The fix anchors on the recipe's own cdpPort Chrome and only honors an
// EXPLICIT window name.
describe('resolveRecordingTarget', () => {
  const base = {
    recordPid: 0,
    recordWindowName: '',
    recordAppName: 'Google Chrome',
    cdpPort: 9324,
  };

  it('anchors on the cdpPort Chrome and never matches a window by the shared default title', async () => {
    let captureCalled = false;
    const target = await resolveRecordingTarget(base, {
      pidListeningOnPort: async (port) => {
        assert.equal(port, 9324);
        return 4242;
      },
      resolveCaptureHelperTarget: async () => {
        captureCalled = true;
        return { selected: { id: '99' } };
      },
    });
    assert.deepEqual(target, { kind: 'pid', pid: 4242 });
    assert.equal(captureCalled, false);
  });

  it('uses an explicit window name when it matches', async () => {
    const target = await resolveRecordingTarget(
      { ...base, recordWindowName: 'macwork-ff-2' },
      {
        pidListeningOnPort: async () => 4242,
        resolveCaptureHelperTarget: async (args) => {
          assert.ok(args.includes('macwork-ff-2'));
          return { selected: { id: '77' } };
        },
      },
    );
    assert.deepEqual(target, { kind: 'window-id', windowId: '77' });
  });

  it('falls back to the cdpPort Chrome when an explicit window name has no match', async () => {
    const target = await resolveRecordingTarget(
      { ...base, recordWindowName: 'macwork-ff-2' },
      {
        pidListeningOnPort: async () => 4242,
        resolveCaptureHelperTarget: async () => ({ selected: null }),
      },
    );
    assert.deepEqual(target, { kind: 'pid', pid: 4242 });
  });

  it('honors an explicit recordPid above everything', async () => {
    const target = await resolveRecordingTarget(
      { ...base, recordPid: 1234 },
      {
        pidListeningOnPort: async () => 4242,
        resolveCaptureHelperTarget: async () => ({ selected: { id: '1' } }),
      },
    );
    assert.deepEqual(target, { kind: 'pid', pid: 1234 });
  });

  it('returns an app-window descriptor (not a silent wrong window) when nothing resolves', async () => {
    const target = await resolveRecordingTarget(base, {
      pidListeningOnPort: async () => null,
      resolveCaptureHelperTarget: async () => ({ selected: { id: '1' } }),
    });
    assert.equal(target.kind, 'app-window');
  });
});

describe('gatewayTokenSeedScript', () => {
  it('seeds the localStorage keys the UI reads so the slot UI authenticates on load', () => {
    const script = gatewayTokenSeedScript('tok-123');
    assert.match(script, /localStorage\.setItem\('farmslot\.gateway\.authMode', 'token'\)/);
    assert.match(script, /localStorage\.setItem\('farmslot\.gateway\.token', "tok-123"\)/);
  });

  it('JSON-escapes the token so quotes/backslashes cannot break out of the script', () => {
    const script = gatewayTokenSeedScript('a"b\\c');
    // The token must be embedded as a valid JSON string literal.
    assert.ok(script.includes(JSON.stringify('a"b\\c')));
    assert.doesNotMatch(script, /token', 'a"b/);
  });
});
