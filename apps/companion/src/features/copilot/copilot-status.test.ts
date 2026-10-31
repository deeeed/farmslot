import assert from 'node:assert/strict';
import test from 'node:test';

import type { CopilotRuntimeSession } from '@farmslot/protocol';

import { copilotStatusLine } from './copilot-status';

// Review r1: a cold start with the gateway down read "Finding Co-Pilot…" forever.
test('offline, Co-Pilot shows its saved status or nothing, never a read that cannot happen', () => {
  const saved: Pick<CopilotRuntimeSession, 'status'> = { status: 'running' };
  assert.equal(copilotStatusLine(null, false, true), '');
  assert.equal(copilotStatusLine(saved, false, false), 'Co-Pilot is running');
  assert.equal(copilotStatusLine(null, true, true), 'Finding Co-Pilot…');
  assert.equal(copilotStatusLine(null, true, false), 'Co-Pilot unavailable');
});
