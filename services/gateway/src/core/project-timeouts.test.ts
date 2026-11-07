import assert from 'node:assert/strict';
import test from 'node:test';

import type { RawProjectJson } from './config.js';
import { runtimeBootTimeoutMs } from './project-timeouts.js';

test('runtime boot reserves the default budget unless preparation explicitly overrides it', () => {
  const cases: Array<[RawProjectJson, number]> = [
    [{}, 900_000],
    [{ timeouts: { build_compile_s: 600 } }, 900_000],
    [{ timeouts: { build_compile_s: 5400 } }, 5_400_000],
    [{ timeouts: { prepare_preflight_s: 600, build_compile_s: 5400 } }, 600_000],
    [{ timeouts: { prepare_preflight_s: 3600 } }, 3_600_000],
    [{ timeouts: { build_compile_s: -1 } }, 900_000],
  ];
  for (const [project, expected] of cases)
    assert.equal(runtimeBootTimeoutMs(project), expected, JSON.stringify(project));
});
