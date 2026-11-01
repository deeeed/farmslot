// performance-observer: the React Native performance sources a host opens for
// a capture window. Android reads native frames from gfxinfo; a CDP host
// (Hermes on iOS) traces through recipe-runner's collector, writing its clock
// marker with `performance.mark` in the app's JavaScript runtime. The host
// connects the CDP client and names the trace kind, platform and marker prefix.
import {
  type CdpClient,
  createCdpTraceCollector,
  type PerformanceBackend,
  type TraceKind,
} from '@farmslot/recipe-runner/runtime/cdp-trace';

export {
  type AndroidFrameSample,
  type AndroidGfxinfoCaptureResult,
  type AndroidGfxinfoPerformanceBackend,
  type AndroidGfxinfoPerformanceOptions,
  createAndroidGfxinfoPerformanceBackend,
} from './android-gfxinfo-performance.js';

const MARKER_TIMEOUT_MS = 10_000;

export interface ReactNativeTracePerformanceOptions<P extends string = string> {
  kind: TraceKind;
  platform: P;
  markerPrefix?: string;
}

export function createReactNativeTracePerformanceBackend<P extends string = string>(
  client: CdpClient,
  { kind, platform, markerPrefix }: ReactNativeTracePerformanceOptions<P>,
): PerformanceBackend<P> {
  return createCdpTraceCollector(client, {
    kind,
    platform,
    markerPrefix,
    async marker(name) {
      const before = Date.now();
      await client.send(
        'Runtime.evaluate',
        {
          expression: `performance.mark(${JSON.stringify(name)})`,
          returnByValue: true,
          awaitPromise: false,
        },
        MARKER_TIMEOUT_MS,
      );
      const after = Date.now();
      return { hostEpochMs: (before + after) / 2, uncertaintyMs: (after - before) / 2 };
    },
  });
}
