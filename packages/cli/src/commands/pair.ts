// commands/pair.ts — mint pairing codes and render a QR to pair the mobile app.
//
// The companion app (App Store / Play Store) scans this QR, exchanges its one
// device code for a credential, and connects to the gateway for tmux control. The
// QR carries one profile per reachable address (LAN, and Tailscale when present);
// the app tries each and keeps whichever connects (gateway-pairing.ts fallback).
//
// Requires the gateway to run with token/password auth — pairing.create rejects
// an unauthenticated gateway. `farmslot up` starts it that way.
import { spawnSync } from 'node:child_process';
import { hostname, networkInterfaces } from 'node:os';

import type { Command } from 'commander';
import * as QRCode from 'qrcode';

import {
  buildGatewayPairingQrPayload,
  type PairingAuthority,
  type PairingCreateResult,
  parseTailscaleDnsNameFromStatus,
} from '@farmslot/protocol';

import { bold, cyan, dim, green } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';

export interface ReachableAddress {
  url: string;
  name: string;
}

export interface PairOptions {
  principal?: string;
  newService?: string;
  role?: Array<'admin' | 'operator'>;
}

/**
 * Non-internal IPv4 addresses, preferring private LAN ranges (RFC1918) so a
 * Wi-Fi address wins over VPN/virtual interfaces. Falls back to all non-internal
 * addresses when none are private. Every candidate becomes its own QR profile,
 * and the app tries each (multi-URL fallback), so extras are harmless.
 */
function lanIPv4s(): string[] {
  const all: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) all.push(iface.address);
    }
  }
  const isPrivate = (ip: string): boolean =>
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const priv = all.filter(isPrivate);
  return [...new Set(priv.length > 0 ? priv : all)];
}

function tailscaleDnsName(): string | null {
  const result = spawnSync('tailscale', ['status', '--json'], {
    encoding: 'utf-8',
    timeout: 4000,
  });
  if (result.error || result.status !== 0) return null;
  return parseTailscaleDnsNameFromStatus(result.stdout);
}

export function reachableAddressesForPairing(
  port: string,
  lanIps: string[],
  tailnet: string | null,
): ReachableAddress[] {
  const host = hostname().replace(/\.local$/, '');
  const addresses: ReachableAddress[] = [];
  for (const ip of lanIps) {
    addresses.push({ url: `ws://${ip}:${port}/ws`, name: `${host} (LAN)` });
  }
  if (tailnet) addresses.push({ url: `ws://${tailnet}:${port}/ws`, name: `${host} (Tailscale)` });
  return addresses;
}

function reachableAddresses(port: string): ReachableAddress[] {
  return reachableAddressesForPairing(port, lanIPv4s(), tailscaleDnsName());
}

export function registerPairCommand(program: Command): void {
  program
    .command('pair')
    .description('Show a QR to pair the mobile companion app for tmux control')
    .option('--principal <principal-id>', 'pair as an existing principal')
    .option('--new-service <display-name>', 'create a service principal when the code is redeemed')
    .option('--role <role...>', 'required role bindings for --new-service')
    .action(async (opts: PairOptions, cmd: Command) => {
      const { client, output, target } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      let authority: PairingAuthority;
      try {
        authority = pairingAuthority(opts);
      } catch (error) {
        emit.fail(error);
        return;
      }
      const port = new URL(target.url).port || '7777';
      const addresses = reachableAddresses(port);
      if (addresses.length === 0) {
        emit.fail(
          Object.assign(new Error('No reachable LAN or Tailscale address found.'), {
            code: 'NO_PAIRING_ADDRESS',
            userAction:
              'Connect to a network, or install and sign in to Tailscale for away-from-LAN pairing, then re-run `farmslot pair`.',
          }),
        );
        return;
      }

      const primaryAddress = addresses[0]!;
      const pairing = await withProgress(
        'Creating pairing code',
        () =>
          client.call<PairingCreateResult>('pairing.create', {
            gatewayUrl: primaryAddress.url,
            profileName: primaryAddress.name,
            authority,
          }),
        !emit.machine,
      );
      const payload = buildGatewayPairingQrPayload(
        pairing,
        addresses.map((address) => ({
          gatewayUrl: address.url,
          profileName: address.name,
        })),
      );
      const profiles = payload.profiles;

      if (emit.machine) {
        // Machine envelope (matrix: legacy raw-JSON output resolved); the QR
        // payload lives under data.payload.
        emit.ok({ payload });
        return;
      }

      const qr = await QRCode.toString(JSON.stringify(payload), { type: 'terminal', small: true });
      output.write(`\n${qr}\n`);
      output.write(`${bold('Scan with the Farmslot companion app')} (App Store / Play Store)\n\n`);
      for (const profile of profiles) {
        output.write(`  ${green('•')} ${profile.profileName}  ${cyan(profile.url)}\n`);
      }
      const hasTailscale = profiles.some(
        (profile) => profile.profileName?.includes('(Tailscale)') ?? false,
      );
      if (hasTailscale) {
        output.write(
          `${dim('  Tailscale detected — scan on any device signed into this tailnet.')}\n`,
        );
      } else {
        output.write(
          `${dim('  Tip: install and sign in to Tailscale on this Mac and phone, then re-run farmslot pair for away-from-LAN access.')}\n`,
        );
      }
      output.write(`${dim(`  codes expire ${profiles[0]?.expiresAt ?? 'unknown'}`)}\n`);
    });
}

export function pairingAuthority(opts: PairOptions): PairingAuthority {
  if (Boolean(opts.principal) === Boolean(opts.newService)) {
    throw Object.assign(new Error('use exactly one of --principal or --new-service'), {
      code: 'INVALID_PARAMS',
      userAction: 're-run with --principal <id>, or --new-service <name> --role <role>',
    });
  }
  if (opts.principal) return { kind: 'existing-principal', principalId: opts.principal };
  const roles = opts.role;
  if (!opts.newService || !roles?.length) {
    throw Object.assign(new Error('--new-service requires at least one --role'), {
      code: 'INVALID_PARAMS',
      userAction: 're-run with --new-service <name> --role operator (or admin)',
    });
  }
  for (const role of roles) {
    if (role !== 'admin' && role !== 'operator') {
      throw Object.assign(new Error(`invalid pairing role '${role}'`), { code: 'INVALID_PARAMS' });
    }
  }
  return {
    kind: 'new-service-principal',
    displayName: opts.newService,
    roles: roles.map((role) => ({ role, scope: { kind: 'global' } })),
  };
}
