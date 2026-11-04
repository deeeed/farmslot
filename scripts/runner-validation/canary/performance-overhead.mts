import assert from 'node:assert/strict';
import { PerformanceRecorder } from '../../../packages/protocol/src/performance/index.js';
import { measureGatewayRequest } from '../../../services/gateway/src/observability/performance.js';
export async function measurePerformanceOverhead() {
  const samples = 5000,
    rounds = 7,
    plain: number[] = [],
    wrapped: number[] = [];
  const metrics = new PerformanceRecorder('gateway', { methods: new Set(['performance.fixture']) });
  const operation = () => Promise.resolve(42);
  for (let round = 0; round < rounds + 2; round++) {
    const before = performance.now();
    for (let i = 0; i < samples; i++) assert.equal(await operation(), 42);
    const middle = performance.now();
    for (let i = 0; i < samples; i++)
      assert.equal(await measureGatewayRequest('performance.fixture', operation, metrics), 42);
    const after = performance.now();
    if (round >= 2) {
      plain.push((middle - before) / samples);
      wrapped.push((after - middle) / samples);
    }
  }
  plain.sort((a, b) => a - b);
  wrapped.sort((a, b) => a - b);
  return {
    samplesPerRound: samples,
    rounds,
    unwrappedMedianMs: plain[3],
    wrappedMedianMs: wrapped[3],
    addedMedianMs: Math.max(0, wrapped[3] - plain[3]),
  };
}
