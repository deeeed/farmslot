import type { IncomingMessage, ServerResponse } from 'node:http';

import { renderPrometheus } from '@farmslot/protocol/performance';

import { authorizeHttpRequest, type GatewayAuthRuntime } from '../security/auth.js';

import { gatewayPerformance } from './performance.js';
export async function servePerformanceMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: GatewayAuthRuntime,
): Promise<void> {
  if (!(await authorizeHttpRequest({ runtime, req, res, resource: 'metrics' }))) return;
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(renderPrometheus(gatewayPerformance.snapshot()));
}
