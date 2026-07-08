// commands/certs.ts — provision a locally-trusted TLS cert so the gateway can
// serve wss://. A hosted HTTPS Command Center (https://farmslot.io/cc) cannot
// open a ws:// socket to a local gateway — Chrome 150 blocks it as mixed content
// — but wss:// is not blocked, so `farmslot certs setup` mints a cert (via mkcert,
// whose local CA the browser already trusts) covering localhost + this machine's
// LAN address. After it runs, `farmslot up` picks the cert up automatically.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';

import type { Command } from 'commander';

import { bold, cyan, dim, green, yellow } from '../colors.js';
import { defaultGatewayCertPath, defaultGatewayKeyPath, gatewayCertsDir } from '../gateway-tls.js';
import { OutputContext } from '../output.js';

function mkcertAvailable(): boolean {
  return spawnSync('mkcert', ['-version'], { stdio: 'ignore' }).status === 0;
}

/** localhost + loopback + this machine's LAN hostname/IPs — the names a hosted
 * CC page (or a phone on the LAN) uses to reach `wss://…:<tlsPort>/ws`. */
function certSans(): string[] {
  const sans = new Set<string>(['localhost', '127.0.0.1', '::1']);
  const host = hostname().replace(/\.local$/, '');
  if (host) sans.add(host);
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) sans.add(iface.address);
    }
  }
  return [...sans];
}

function setup(output: OutputContext): void {
  if (!mkcertAvailable()) {
    output.error(
      'mkcert is not installed — it is required to mint a locally-trusted TLS cert. ' +
        'Next: install it (macOS: `brew install mkcert`; see https://github.com/FiloSottile/mkcert#installation), ' +
        'then re-run `farmslot certs setup`.',
    );
    process.exit(1);
  }

  // Install the mkcert local CA into the system/browser trust stores (idempotent).
  const install = spawnSync('mkcert', ['-install'], { stdio: 'inherit' });
  if (install.status !== 0) {
    output.error(
      'mkcert -install failed to register the local CA. ' +
        'Next: run `mkcert -install` manually to see the error, then re-run `farmslot certs setup`.',
    );
    process.exit(1);
  }

  const certPath = defaultGatewayCertPath();
  const keyPath = defaultGatewayKeyPath();
  mkdirSync(gatewayCertsDir(), { recursive: true, mode: 0o700 });

  const sans = certSans();
  const issue = spawnSync('mkcert', ['-cert-file', certPath, '-key-file', keyPath, ...sans], {
    stdio: 'inherit',
  });
  if (issue.status !== 0 || !existsSync(certPath) || !existsSync(keyPath)) {
    output.error(
      `mkcert failed to issue the cert (expected ${certPath}). ` +
        'Next: re-run `farmslot certs setup`; if it persists, run the printed mkcert command manually.',
    );
    process.exit(1);
  }

  if (output.json) {
    output.writeJson({ certPath, keyPath, sans });
    return;
  }
  output.write(`${green('gateway TLS cert ready')}\n`);
  output.write(`  ${dim('cert')}   ${cyan(certPath)}\n`);
  output.write(`  ${dim('key')}    ${cyan(keyPath)}\n`);
  output.write(`  ${dim('names')}  ${dim(sans.join(', '))}\n`);
  output.write(
    `  ${dim('next')}   ${bold('farmslot up')} ${dim('(picks up the cert and serves wss://)')}\n`,
  );
  output.write(
    `${dim('  The hosted Command Center (https://farmslot.io/cc) can now reach this gateway again.')}\n`,
  );
  output.write(
    `${yellow('  Note:')} ${dim('the cert covers this machine’s current LAN address — re-run after your IP changes.')}\n`,
  );
}

export function registerCertsCommand(program: Command): void {
  const certs = program
    .command('certs')
    .description('Manage the gateway TLS cert used for wss:// (hosted Command Center support)');

  certs
    .command('setup')
    .description('Provision a locally-trusted TLS cert (mkcert) so the gateway can serve wss://')
    .action((_opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      setup(output);
    });
}
