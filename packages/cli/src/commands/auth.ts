import type { Command } from 'commander';

import { dim, green, red, yellow } from '../colors.js';
import { describeProbe, exchangePairingCode, probeGatewayAuth } from '../gateway-auth.js';
import {
  type GatewayProfilesFile,
  loadProfiles,
  profileCredential,
  saveProfiles,
} from '../gateway-profiles.js';
import { OutputContext } from '../output.js';

function requireProfile(
  profiles: GatewayProfilesFile,
  name: string | undefined,
  output: OutputContext,
): { name: string } {
  const resolved = name ?? profiles.active;
  if (!resolved) {
    output.error(
      'no profile given and no active profile — add one with: farmslot gateway add <name> --profile-url <ws-url>',
    );
    process.exit(1);
  }
  if (!profiles.gateways[resolved]) {
    output.error(`profile '${resolved}' not found (see: farmslot gateway list)`);
    process.exit(1);
  }
  return { name: resolved };
}

interface LoginOptions {
  code?: string;
  token?: string;
  password?: string;
}

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Authenticate a gateway profile (pairing code, token, or password)')
    .argument('[profile]', 'profile name; defaults to the active profile')
    .option('--code <pairing-code>', 'pairing code from Command Center / pairing.create')
    .option('--token <token>', 'gateway token credential')
    .option('--password <password>', 'gateway password credential')
    .action(async (profileArg: string | undefined, opts: LoginOptions, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      try {
        const profiles = loadProfiles();
        const { name } = requireProfile(profiles, profileArg, output);
        const profile = profiles.gateways[name];

        if (opts.code) {
          const exchanged = await exchangePairingCode(profile.url, opts.code);
          profile.authMode = exchanged.authMode;
          profile.secret = exchanged.secret;
        } else if (opts.token) {
          profile.authMode = 'token';
          profile.secret = opts.token;
        } else if (opts.password) {
          profile.authMode = 'password';
          profile.secret = opts.password;
        }
        // No credential flags: verify whatever is stored (or that none is needed).

        const probe = await probeGatewayAuth(profile.url, profileCredential(profile));
        if (probe.state === 'authenticated' || probe.state === 'no-auth') {
          if (opts.code || opts.token || opts.password) saveProfiles(profiles);
          if (output.json) {
            output.writeJson({ profile: name, state: probe.state, authMode: probe.authMode });
          } else {
            output.write(`${green('[OK]')} ${describeProbe(name, profile, probe)}\n`);
            if (probe.state === 'no-auth' && (opts.token || opts.password || opts.code)) {
              output.write(
                `${dim('gateway requires no auth — credential stored for later use')}\n`,
              );
            }
          }
          return;
        }
        // Failed verification must not persist a bad credential.
        output.error(describeProbe(name, profile, probe));
        if (probe.state === 'inactive' && !opts.code && !opts.token && !opts.password) {
          output.error(
            'provide a credential: farmslot login ' +
              name +
              ' --code <pairing-code> | --token <t> | --password <p>',
          );
        }
        process.exit(1);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  program
    .command('logout')
    .description('Forget the stored credential for a gateway profile')
    .argument('[profile]', 'profile name; defaults to the active profile')
    .action((profileArg: string | undefined, _opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const profiles = loadProfiles();
      const { name } = requireProfile(profiles, profileArg, output);
      const profile = profiles.gateways[name];
      const hadSecret = Boolean(profile.secret);
      delete profile.secret;
      delete profile.authMode;
      saveProfiles(profiles);
      if (output.json) output.writeJson({ profile: name, loggedOut: hadSecret });
      else {
        output.write(
          hadSecret
            ? `${green('[OK]')} ${name}: credential removed\n`
            : `${dim(`${name}: no stored credential`)}\n`,
        );
      }
    });

  const auth = program.command('auth').description('Gateway authentication');
  auth
    .command('status')
    .description('Show auth state for one or all gateway profiles')
    .argument('[profile]', 'profile name; defaults to the active profile')
    .option('--all', 'probe every configured profile')
    .action(async (profileArg: string | undefined, opts: { all?: boolean }, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const profiles = loadProfiles();
      let names: string[];
      if (opts.all) {
        names = Object.keys(profiles.gateways);
        if (names.length === 0) {
          output.error('no gateway profiles configured');
          process.exit(1);
        }
      } else {
        names = [requireProfile(profiles, profileArg, output).name];
      }

      const results = await Promise.all(
        names.map(async (name) => {
          const profile = profiles.gateways[name];
          const probe = await probeGatewayAuth(profile.url, profileCredential(profile));
          return { name, profile, probe };
        }),
      );

      const ok = results.every(
        (r) => r.probe.state === 'authenticated' || r.probe.state === 'no-auth',
      );
      if (output.json) {
        output.writeJson({
          ok,
          profiles: results.map((r) => ({
            profile: r.name,
            url: r.profile.url,
            state: r.probe.state,
            authMode: r.probe.authMode ?? null,
            detail: r.probe.detail,
          })),
        });
      } else {
        for (const r of results) {
          const mark =
            r.probe.state === 'authenticated' || r.probe.state === 'no-auth'
              ? green('[OK]')
              : r.probe.state === 'inactive'
                ? yellow('[WARN]')
                : red('[FAIL]');
          output.write(`${mark} ${describeProbe(r.name, r.profile, r.probe)}\n`);
        }
      }
      if (!ok) process.exit(1);
    });
}
