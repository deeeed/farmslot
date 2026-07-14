import http from 'node:http';
import https from 'node:https';

import type { Command } from 'commander';

import type { NodesListResult } from '@farmslot/protocol';

import { bold, cyan, dim, green, red } from '../colors.js';
import { resolveContext } from '../context.js';
import { isMachineMode } from '../envelope.js';
import {
  assertGatewayUrl,
  assertProfileName,
  type GatewayProfile,
  loadProfiles,
  loadProfilesOrExit,
  saveProfiles,
} from '../gateway-profiles.js';
import { OutputContext } from '../output.js';
import { withProgress } from '../progress.js';

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
  if (result.error) lines.push(`${dim('RPC:')} ${red(result.error)}`);
  return lines.join('\n');
}

export function registerGatewayCommand(program: Command): void {
  const gateway = program.command('gateway').description('Gateway management');

  gateway
    .command('status')
    .description('Show Gateway health and connected node count')
    .action(async (_opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const { client, output, target } = resolveContext(cmd);
      const url = target.url;
      const timeoutMs = Number(opts.timeout);
      const healthUrl = gatewayHealthUrl(url);
      try {
        const health = await withProgress(
          `Probing ${url}`,
          () => readHealth(healthUrl, timeoutMs),
          !isMachineMode(output),
        );
        try {
          const nodes = await withProgress(
            'Loading nodes',
            () => client.call<NodesListResult>('nodes.list'),
            !isMachineMode(output),
          );
          const result: GatewayStatusResult = { url, healthUrl, reachable: true, health, nodes };
          if (output.json) output.writeJson(result);
          else output.write(`${formatGatewayStatus(result)}\n`);
        } catch (rpcErr) {
          const result: GatewayStatusResult = {
            url,
            healthUrl,
            reachable: true,
            health,
            error: `nodes.list failed: ${
              rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
            }`,
          };
          if (output.json) output.writeJson(result);
          else output.error(formatGatewayStatus(result));
          process.exit(1);
        }
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

  registerProfileSubcommands(gateway);
}

/** Strip secrets for any output path — tokens never leave the store file. */
export function redactProfile(name: string, profile: GatewayProfile, active: string | undefined) {
  return {
    name,
    url: profile.url,
    active: name === active,
    authMode: profile.authMode ?? null,
    loggedIn: Boolean(profile.secret),
  };
}

function registerProfileSubcommands(gateway: Command): void {
  gateway
    .command('add')
    .description('Add a named gateway profile')
    .argument('<name>', 'profile name (lowercase kebab-case)')
    // Positional URL: the global --url target flag is parsed at program level,
    // so a same-named subcommand option can never receive a value.
    .argument('<ws-url>', 'gateway WebSocket URL, e.g. wss://host:7777')
    .option('--use', 'make this the active profile')
    .action((name: string, url: string, opts: { use?: boolean }, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      try {
        assertProfileName(name);
        assertGatewayUrl(url);
        const profiles = loadProfiles();
        if (profiles.gateways[name]) {
          output.error(`profile '${name}' already exists — remove it first or pick another name`);
          process.exit(1);
        }
        profiles.gateways[name] = { url };
        if (opts.use || !profiles.active) profiles.active = name;
        saveProfiles(profiles);
        const entry = redactProfile(name, profiles.gateways[name], profiles.active);
        if (output.json) output.writeJson(entry);
        else {
          output.write(
            `${green('added')} ${name} ${dim(url)}${entry.active ? ` ${dim('(active)')}` : ''}\n` +
              `${dim(`next: farmslot login ${name}`)}\n`,
          );
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  gateway
    .command('remove')
    .description('Remove a gateway profile')
    .argument('<name>', 'profile name')
    .action((name: string, _opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const profiles = loadProfilesOrExit(output);
      if (!profiles.gateways[name]) {
        output.error(`profile '${name}' not found`);
        process.exit(1);
      }
      delete profiles.gateways[name];
      if (profiles.active === name) delete profiles.active;
      saveProfiles(profiles);
      if (output.json) output.writeJson({ removed: name });
      else output.write(`${green('removed')} ${name}\n`);
    });

  gateway
    .command('list')
    .description('List gateway profiles (secrets never shown)')
    .action((_opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const profiles = loadProfilesOrExit(output);
      const entries = Object.entries(profiles.gateways).map(([name, profile]) =>
        redactProfile(name, profile, profiles.active),
      );
      if (output.json) {
        output.writeJson({ active: profiles.active ?? null, gateways: entries });
        return;
      }
      if (entries.length === 0) {
        output.write(
          `${dim('no profiles — add one with: farmslot gateway add <name> <ws-url>')}\n`,
        );
        return;
      }
      for (const entry of entries) {
        const marker = entry.active ? green('* ') : '  ';
        const auth = entry.loggedIn ? green(`${entry.authMode} (logged in)`) : dim('no credential');
        output.write(`${marker}${bold(entry.name)}  ${entry.url}  ${auth}\n`);
      }
    });

  gateway
    .command('use')
    .description('Set the active gateway profile')
    .argument('<name>', 'profile name')
    .action((name: string, _opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const profiles = loadProfilesOrExit(output);
      if (!profiles.gateways[name]) {
        output.error(
          `profile '${name}' not found — add it with: farmslot gateway add ${name} <ws-url>`,
        );
        process.exit(1);
      }
      profiles.active = name;
      saveProfiles(profiles);
      if (output.json) output.writeJson({ active: name });
      else
        output.write(`${green('active profile:')} ${name} ${dim(profiles.gateways[name].url)}\n`);
    });
}
