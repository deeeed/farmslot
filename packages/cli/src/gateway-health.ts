import http from 'node:http';

import type { GatewayListenInfo } from '@farmslot/protocol';

export interface GatewayHealthPayload {
  status?: string;
  uptime?: number;
  listen?: GatewayListenInfo;
}

export function readGatewayHealth(url: string, timeoutMs = 3_000): Promise<GatewayHealthPayload> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as GatewayHealthPayload);
        } catch (err) {
          reject(new Error(`Invalid health response: ${(err as Error).message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

export function gatewayHealthUrlFromWs(wsUrl: string): string | null {
  try {
    const url = new URL(wsUrl);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '::1') {
      return null;
    }
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function localGatewayHealthCandidates(): string[] {
  const ports = new Set<number>();
  const portEnv = process.env.GATEWAY_PORT?.trim();
  if (portEnv) {
    const parsed = Number.parseInt(portEnv, 10);
    if (parsed > 0) ports.add(parsed);
  }
  const gwUrl = process.env.GW_URL?.trim();
  if (gwUrl) {
    try {
      const parsed = Number.parseInt(new URL(gwUrl).port, 10);
      if (parsed > 0) ports.add(parsed);
    } catch {
      // ignore malformed GW_URL
    }
  }
  ports.add(7777);
  ports.add(7801);
  return [...ports].map((port) => `http://127.0.0.1:${port}/health`);
}

export async function probeLocalGatewayListen(): Promise<GatewayListenInfo | null> {
  for (const healthUrl of localGatewayHealthCandidates()) {
    try {
      const health = await readGatewayHealth(healthUrl);
      if (health.listen) return health.listen;
    } catch {
      // try next candidate port
    }
  }
  return null;
}
