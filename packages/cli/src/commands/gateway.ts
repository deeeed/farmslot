import http from 'node:http';
import https from 'node:https';

import type { Command } from 'commander';

import type { NodesListResult } from '@farmslot/protocol';

import { bold, cyan, dim, green, red } from '../colors.js';
import { resolveContext } from '../context.js';

interface GatewayHealthResult {
  status?: string;
  uptime?: number;
}

interface GatewayStatusResult {
  url: string;
  healthUrl: string;
  reachable: boolean;
  health?: GatewayHealthResult;
  nodes?: NodesListResult;
  error?: string;
}

function gatewayHealthUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/health';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function readHealth(url: string, timeoutMs: number): Promise<GatewayHealthResult> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
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
          resolve(JSON.parse(body) as GatewayHealthResult);
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

function formatUptime(seconds: number | undefined): string {
  if (seconds == null) return '-';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatGatewayStatus(result: GatewayStatusResult): string {
  if (!result.reachable) {
    return [
      `${bold('Gateway:')} ${red('DOWN')}`,
      `${dim('URL:')} ${result.url}`,
      `${dim('Health:')} ${result.healthUrl}`,
      result.error ? red(result.error) : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const lines = [
    `${bold('Gateway:')} ${green('OK')}`,
    `${dim('URL:')} ${result.url}`,
    `${dim('Health:')} ${result.healthUrl}`,
    `${dim('Uptime:')} ${formatUptime(result.health?.uptime)}`,
  ];
  if (result.nodes) {
    lines.push(`${dim('Nodes:')} ${green(String(result.nodes.nodes.length))}`);
    if (result.nodes.nodes.length > 0) {
      lines.push(
        `${dim('Connected:')} ${result.nodes.nodes.map((node) => cyan(node.machine)).join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}

export function registerGatewayCommand(program: Command): void {
  const gateway = program.command('gateway').description('Gateway management');

  gateway
    .command('status')
    .description('Show Gateway health and connected node count')
    .action(async (_opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const { client, output } = resolveContext(cmd);
      const url = String(opts.url);
      const timeoutMs = Number(opts.timeout);
      const healthUrl = gatewayHealthUrl(url);
      try {
        const health = await readHealth(healthUrl, timeoutMs);
        let nodes: NodesListResult | undefined;
        try {
          nodes = await client.call<NodesListResult>('nodes.list');
        } catch {
          nodes = undefined;
        }
        const result: GatewayStatusResult = { url, healthUrl, reachable: true, health, nodes };
        if (output.json) output.writeJson(result);
        else output.write(`${formatGatewayStatus(result)}\n`);
      } catch (err) {
        const result: GatewayStatusResult = {
          url,
          healthUrl,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        };
        if (output.json) output.writeJson(result);
        else output.error(formatGatewayStatus(result));
        process.exit(1);
      }
    });
}
