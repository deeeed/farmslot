// commands/pair.ts — mint pairing codes and render a QR to pair the mobile app.
//
// The companion app (App Store / Play Store) scans this QR, exchanges each code
// for a credential, and connects to the gateway for tmux control on the go. The
// QR carries one profile per reachable address (LAN, and Tailscale when present);
// the app tries each and keeps whichever connects (gateway-pairing.ts fallback).
//
// Requires the gateway to run with token/password auth — pairing.create rejects
// an unauthenticated gateway. `farmslot up` starts it that way.
import { spawnSync } from 'node:child_process';
import { hostname, networkInterfaces } from 'node:os';

import type { Command } from 'commander';
import * as QRCode from 'qrcode';

import type { PairingCreateResult } from '@farmslot/protocol';

import { bold, cyan, dim, green } from '../colors.js';
import { resolveContext } from '../context.js';

const PAIRING_QR_TYPE = 'farmslot.gateway-pairing.v1';

interface PairingQrPayload {
  type: typeof PAIRING_QR_TYPE;
  profiles: PairingCreateResult[];
}

export interface ReachableAddress {
  url: string;
  name: string;
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

/** Tailscale MagicDNS name for "from anywhere" access, or null when Tailscale is absent. */
export function parseTailscaleDnsNameFromStatus(stdout: string): string | null {
  // Tailscale present but unparseable status = treat as absent; pairing still
  // works over LAN. This is the one expected, recoverable miss, not a swallow.
  let status: { Self?: { DNSName?: string } };
  try {
    status = JSON.parse(stdout);
  } catch {
    return null;
  }
  const dns = status.Self?.DNSName?.replace(/\.$/, '');
  return dns && dns.length > 0 ? dns : null;
}

/** Tailscale MagicDNS name for "from anywhere" access, or null when Tailscale is absent. */
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
    .action(async (_opts: unknown, cmd: Command) => {
      const { client, output, target } = resolveContext(cmd);
      const port = new URL(target.url).port || '7777';
      const addresses = reachableAddresses(port);
      if (addresses.length === 0) {
        output.error(
          'no reachable LAN or Tailscale address found — connect to a network, or install Tailscale for remote pairing',
        );
        process.exit(1);
      }

      const profiles: PairingCreateResult[] = [];
      for (const address of addresses) {
        profiles.push(
          await client.call<PairingCreateResult>('pairing.create', {
            gatewayUrl: address.url,
            profileName: address.name,
          }),
        );
      }
      const payload: PairingQrPayload = { type: PAIRING_QR_TYPE, profiles };

      if (output.json) {
        output.writeJson(payload);
        return;
      }

      const qr = await QRCode.toString(JSON.stringify(payload), { type: 'terminal', small: true });
      output.write(`\n${qr}\n`);
      output.write(`${bold('Scan with the Farmslot companion app')} (App Store / Play Store)\n\n`);
      for (const profile of profiles) {
        output.write(`  ${green('•')} ${profile.profileName}  ${cyan(profile.url)}\n`);
      }
      const hasTailscale = profiles.some((profile) => profile.profileName.includes('(Tailscale)'));
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
