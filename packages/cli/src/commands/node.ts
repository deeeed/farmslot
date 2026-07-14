import type { Command } from 'commander';

import type { NodeDeployResult, NodesListResult } from '@farmslot/protocol';

import { bold, dim, green, red, yellow } from '../colors.js';
import { resolveContext } from '../context.js';
import { withProgress } from '../progress.js';

function formatNodeStatus(result: NodesListResult): string {
  const lines: string[] = [];
  lines.push(`${dim('Gateway protocol:')} ${result.gatewayProtocolVersion}`);
  lines.push('');

  if (result.nodes.length === 0) {
    lines.push(dim('No nodes connected.'));
    return lines.join('\n');
  }

  // Header
  const cols = ['MACHINE', 'PID', 'VERSION', 'MATCH', 'CONNECTED', 'UPTIME'];
  const rows = result.nodes.map((a) => {
    const uptimeStr = a.uptime != null ? formatUptime(a.uptime) : '-';
    const matchStr = a.versionMatch == null ? '-' : a.versionMatch ? '✓' : '✗ MISMATCH';
    return [
      a.machine,
      String(a.pid),
      a.protocolVersion ?? 'unknown',
      matchStr,
      formatAge(a.connectedAt),
      uptimeStr,
    ];
  });

  // Calculate column widths
  const widths = cols.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const header = cols.map((h, i) => h.padEnd(widths[i])).join('  ');
  lines.push(bold(header));
  lines.push(dim(widths.map((w) => '─'.repeat(w)).join('  ')));

  for (const row of rows) {
    const mismatch = row[3].includes('MISMATCH');
    const colored = row.map((c, i) => {
      const padded = c.padEnd(widths[i]);
      if (i === 3 && c === '✓') return green(padded);
      if (i === 3 && mismatch) return yellow(padded);
      if (i === 4) return dim(padded);
      return padded;
    });
    const line = colored.join('  ');
    lines.push(mismatch ? red(line) : line);
  }

  return lines.join('\n');
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function registerNodeCommand(program: Command): void {
  const node = program.command('node').description('Node management');

  node
    .command('status')
    .description('Show connected nodes with version info')
    .action(async (_: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const result = await withProgress(
          'Loading nodes',
          () => client.call<NodesListResult>('nodes.list'),
          !output.json,
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(`${formatNodeStatus(result)}\n`);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  node
    .command('deploy <machine>')
    .description('Deploy/update node on a machine (rsync + restart service)')
    .action(async (machine: string, _: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const result = await withProgress(
          `Deploying node to ${machine}`,
          () => client.call<NodeDeployResult>('nodes.deploy', { machine }),
          !output.json,
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(result.output);
          if (result.success) {
            output.write(`\n${green('✓')} Node deployed to ${machine}\n`);
          } else {
            output.error(`Node deploy to ${machine} failed`);
            process.exit(1);
          }
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
