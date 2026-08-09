import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import {
  CredentialStoreRuntime,
  CredentialStoreWriter,
  readCredentialStoreOffline,
} from '@farmslot/credential-store';
import type {
  CredentialIssueResult,
  CredentialListResult,
  CredentialRevokeResult,
  PrincipalCreateResult,
  PrincipalGrantResult,
  PrincipalSubject,
  Role,
} from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { loadProfiles, saveProfiles } from '../gateway-profiles.js';
import { repoRoot } from '../onboarding/workspace.js';

export function registerCredentialCommands(program: Command): void {
  const credential = program.command('credential').description('Manage gateway credentials');

  credential
    .command('issue')
    .requiredOption('--principal <principal-id>')
    .option('--name <display-name>', 'credential display name; defaults to --principal')
    .option('--subject <subject>', 'create the principal first: person, service, or node')
    .option('--machine <machine>', 'machine binding required with --subject node')
    .option('--role <role>', 'grant admin or operator before issuance')
    .option('--scope <scope>', 'required with --role; only global is supported')
    .option('--write-node-env', 'write the credential to FARMSLOT_NODE_TOKEN in .env.local-auth')
    .option(
      '--secret-file <path>',
      'write the raw secret to a new file (0600, refuses to overwrite) for scripted remote provisioning',
    )
    .option('--offline', 'operate on the store while every gateway is stopped')
    .action(
      async (
        opts: {
          principal: string;
          name?: string;
          subject?: string;
          machine?: string;
          role?: string;
          scope?: string;
          writeNodeEnv?: boolean;
          secretFile?: string;
          offline?: boolean;
        },
        cmd: Command,
      ) => {
        const { output, client, target } = resolveContext(cmd);
        const emit = createEmitter(output, cmd);
        try {
          const principalId = await prepareIssuePrincipal(opts, client);
          const displayName = opts.name?.trim() || opts.principal;
          const issue = opts.offline
            ? offlineIssue(principalId, displayName)
            : await client.call<CredentialIssueResult>('credential.issue', {
                principalId,
                displayName,
              });
          if (opts.writeNodeEnv) writeNodeCredential(issue.secret);
          const secretFilePath = opts.secretFile
            ? writeSecretFile(opts.secretFile, issue.secret)
            : undefined;
          let persistedProfile: string | undefined;
          if (!opts.offline && issue.activationLatched) {
            persistedProfile = persistOwnerCredential(
              target.url,
              target.profileName,
              issue.adminGrant?.secret ?? issue.secret,
            );
          }
          if (emit.machine) {
            emit.ok({
              ...credentialIssueMachineResult(issue),
              ...(secretFilePath ? { secretFile: secretFilePath } : {}),
            });
          } else {
            output.write(
              `Issued credential '${issue.credential.displayName}' for '${issue.credential.principalId}'.\n`,
            );
            if (secretFilePath) {
              output.write(`Secret written to ${secretFilePath} (0600, shown nowhere else).\n`);
            } else {
              output.write(`Secret (shown once): ${issue.secret}\n`);
            }
            if (issue.adminGrant) {
              output.write(
                `Issued owner credential '${issue.adminGrant.credential.displayName}' (admin, global) and wrote it to gateway profile '${persistedProfile}'.\n`,
              );
            } else if (issue.activationLatched) {
              output.write(
                `Wrote the issued admin credential to gateway profile '${persistedProfile}'.\n`,
              );
            }
            if (issue.activationLatched) printActivationWalkthrough(output);
          }
        } catch (error) {
          emit.fail(error);
        }
      },
    );

  credential
    .command('list')
    .option('--include-revoked')
    .option('--offline', 'operate on the store while every gateway is stopped')
    .action(async (opts: { includeRevoked?: boolean; offline?: boolean }, cmd: Command) => {
      const { output, client } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result: CredentialListResult = opts.offline
          ? {
              credentials: readCredentialStoreOffline(process.env)
                .credentials.filter((entry) => opts.includeRevoked || entry.revokedAt === null)
                .map(({ secret: _secret, ...summary }) => summary),
            }
          : await client.call('credential.list', { includeRevoked: opts.includeRevoked });
        if (emit.machine) emit.ok(result);
        else {
          for (const entry of result.credentials) {
            output.write(
              `${entry.id}\t${entry.displayName}\t${entry.principalId}\t${entry.origin}\t${entry.revokedAt ? 'revoked' : 'active'}\n`,
            );
          }
        }
      } catch (error) {
        emit.fail(error);
      }
    });

  credential
    .command('revoke')
    .argument('<credential-id>')
    .option('--offline', 'operate on the store while every gateway is stopped')
    .action(async (credentialId: string, opts: { offline?: boolean }, cmd: Command) => {
      const { output, client } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result: CredentialRevokeResult = opts.offline
          ? { credential: summarize(offlineWriter().revokeCredential(credentialId)) }
          : await client.call('credential.revoke', { credentialId });
        if (emit.machine) emit.ok(result);
        else output.write(`Revoked credential '${result.credential.displayName}'.\n`);
      } catch (error) {
        emit.fail(error);
      }
    });
}

async function prepareIssuePrincipal(
  opts: {
    principal: string;
    subject?: string;
    machine?: string;
    role?: string;
    scope?: string;
    offline?: boolean;
  },
  client: {
    call<T>(method: string, params: unknown): Promise<T>;
  },
): Promise<string> {
  const role = optionalRole(opts.role);
  if (Boolean(role) !== Boolean(opts.scope)) {
    throw Object.assign(new Error('--role and --scope must be provided together'), {
      code: 'INVALID_PARAMS',
    });
  }
  if (opts.scope && opts.scope !== 'global') {
    throw Object.assign(new Error('--scope must be global'), { code: 'INVALID_PARAMS' });
  }
  const roles = role ? [{ role, scope: { kind: 'global' as const } }] : [];
  if (opts.subject) {
    const subject = issueSubject(opts.subject, opts.principal, opts.machine);
    if (subject.type === 'node' && roles.length > 0) {
      throw Object.assign(new Error('node principals cannot hold --role bindings'), {
        code: 'INVALID_PARAMS',
      });
    }
    if (opts.offline) {
      return offlineWriter().createPrincipal(subject, roles, opts.principal).id;
    }
    const created = await client.call<PrincipalCreateResult>('principal.create', {
      subject,
      roles,
    });
    return created.principal.id;
  }
  if (role) {
    if (opts.offline) {
      const store = readCredentialStoreOffline(process.env);
      const writer = offlineWriter();
      const principal = store.principals.find((entry) => entry.id === opts.principal);
      return principal
        ? writer.grantRole(opts.principal, role, { kind: 'global' }).id
        : writer.createPrincipal(
            { type: 'person', displayName: opts.principal },
            roles,
            opts.principal,
          ).id;
    }
    const granted = await client.call<PrincipalGrantResult>('principal.grant', {
      principalId: opts.principal,
      role,
      scope: { kind: 'global' },
    });
    return granted.principal.id;
  }
  return opts.principal;
}

function issueSubject(type: string, displayName: string, machine?: string): PrincipalSubject {
  if (type === 'person' || type === 'service') return { type, displayName };
  if (type === 'node' && machine?.trim()) {
    return { type: 'node', displayName, machine: machine.trim() };
  }
  throw Object.assign(
    new Error('--subject must be person, service, or node (node requires --machine)'),
    { code: 'INVALID_PARAMS' },
  );
}

function optionalRole(value: string | undefined): Role | undefined {
  if (value === undefined) return undefined;
  if (value === 'admin' || value === 'operator') return value;
  throw Object.assign(new Error('--role must be admin or operator'), { code: 'INVALID_PARAMS' });
}

export function credentialIssueMachineResult(issue: CredentialIssueResult): {
  credential: CredentialIssueResult['credential'];
  activationLatched: boolean;
  adminGrant?: CredentialIssueResult['credential'];
  secretReturned: true;
} {
  return {
    credential: issue.credential,
    activationLatched: issue.activationLatched ?? false,
    ...(issue.adminGrant ? { adminGrant: issue.adminGrant.credential } : {}),
    secretReturned: true,
  };
}

function offlineIssue(principalId: string, displayName: string): CredentialIssueResult {
  const issue = offlineWriter().issueCredential(principalId, displayName);
  return {
    credential: summarize(issue.record),
    secret: issue.secret,
    activationLatched: issue.activationLatched,
  };
}

function summarize(record: ReturnType<CredentialStoreWriter['revokeCredential']>) {
  return {
    id: record.id,
    principalId: record.principalId,
    displayName: record.displayName,
    origin: record.origin,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

/**
 * Write the raw secret to a NEW file (0600). Exclusive create: overwriting an
 * existing path is refused so a script can never clobber another secret or a
 * regular file; callers pick a unique path and delete it after delivery.
 * Returns the absolute path. The secret is written without a trailing newline
 * so `cat`/stdin pipelines deliver it byte-exact.
 */
export function writeSecretFile(requestedPath: string, secret: string): string {
  const absolute = resolve(requestedPath);
  writeFileSync(absolute, secret, { mode: 0o600, flag: 'wx' });
  return absolute;
}

function writeNodeCredential(secret: string): void {
  const path = resolve(repoRoot, '.env.local-auth');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const filtered = lines.filter((line) => !/^\s*(?:export\s+)?FARMSLOT_NODE_TOKEN=/u.test(line));
  filtered.push(`FARMSLOT_NODE_TOKEN=${secret}`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${filtered.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function persistOwnerCredential(
  url: string,
  profileName: string | undefined,
  secret: string,
): string {
  const profiles = loadProfiles();
  const matching = Object.entries(profiles.gateways).find(
    ([, profile]) => profile.url === url,
  )?.[0];
  const name = profileName ?? matching ?? uniqueProfileName(profiles.gateways, 'activated-gateway');
  profiles.gateways[name] = { url, authMode: 'token', secret };
  if (!profiles.active || profiles.active === name || !profiles.gateways[profiles.active]) {
    profiles.active = name;
  }
  saveProfiles(profiles);
  return name;
}

function uniqueProfileName(gateways: Record<string, unknown>, base: string): string {
  if (!(base in gateways)) return base;
  let suffix = 2;
  while (`${base}-${suffix}` in gateways) suffix += 1;
  return `${base}-${suffix}`;
}

function printActivationWalkthrough(output: { write(text: string): void }): void {
  output.write(
    '\nThis gateway is now activated, permanently. Two things change:\n' +
      '  - open sessions must re-authenticate; their subscriptions were closed.\n' +
      '  - the local node no longer connects implicitly.\n' +
      "Next: issue the local node's credential and write it where the node reads it:\n" +
      '  farmslot credential issue --principal <machine> --subject node --machine <machine> --write-node-env\n',
  );
}

function offlineRuntime(): CredentialStoreRuntime {
  return new CredentialStoreRuntime(process.env);
}

function offlineWriter(): CredentialStoreWriter {
  return new CredentialStoreWriter(offlineRuntime(), true);
}
