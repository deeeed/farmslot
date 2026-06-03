import assert from 'node:assert/strict';

import type { SlotVars } from '../core/config.js';

export function makeVars(overrides: Partial<SlotVars> = {}): SlotVars {
  return {
    slotId: 'runner-local-test-1',
    machine: 'runner-local',
    platform: 'ios',
    host: 'localhost',
    sshUser: 'tester',
    osType: 'darwin',
    claudePath: '/usr/local/bin/claude',
    codexPath: '/usr/local/bin/codex',
    opencodePath: '/usr/local/bin/opencode',
    cursorPath: '/usr/local/bin/cursor-agent',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/tmp/repo',
    session: 'test-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'tester@localhost',
    remoteRepo: '/tmp/repo',
    projectName: 'test-project',
    resourceVars: { platform: 'ios', slot_id: 'runner-local-test-1' },
    ...overrides,
  };
}

export function assertCodexWorkerDoesNotInjectMcpOverrides(command: string): void {
  assert.doesNotMatch(command, /mcp_servers\.[^. ]+\.enabled=false/);
}
