import type { Command } from 'commander';

import {
  CredentialStoreRuntime,
  CredentialStoreWriter,
  readCredentialStoreOffline,
  retirePrincipalsOffline,
} from '@farmslot/credential-store';
import type {
  PrincipalBindNativeOwnerResult,
  PrincipalCreateResult,
  PrincipalGrantResult,
  PrincipalListResult,
  PrincipalRetireResult,
  PrincipalRevokeRoleResult,
  PrincipalSubject,
  Role,
  RoleBinding,
} from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { OutputContext } from '../output.js';

interface PrincipalCreateOptions {
  type: 'person' | 'service' | 'node';
  name: string;
  machine?: string;
  nativeOwner?: string;
  role?: Role[];
  offline?: boolean;
  reuseRetiredId?: string;
}

export function registerPrincipalCommands(program: Command): void {
  const principal = program.command('principal').description('Manage gateway principals');

  principal
    .command('create')
    .requiredOption('--type <type>', 'person, service, or node')
    .requiredOption('--name <display-name>')
    .option('--machine <machine>', 'required for node subjects')
    .option('--native-owner <principal-id>', 'bind a node to its native account owner')
    .option('--role <role...>', 'admin and/or operator; omission creates roles: []')
    .option('--reuse-retired-id <id>', 'explicitly replace a retired principal at its exact id')
    .option('--offline', 'operate on the store while every gateway is stopped')
    .action(async (opts: PrincipalCreateOptions, cmd: Command) => {
      const { output, client } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const subject = subjectFromOptions(opts);
        const roles = rolesFromOptions(opts.role);
        const result = opts.offline
          ? {
              principal: offlineWriter().createPrincipal(subject, roles, opts.reuseRetiredId, {
                reuseRetiredId: opts.reuseRetiredId !== undefined,
              }),
            }
          : await client.call<PrincipalCreateResult>(
              opts.reuseRetiredId !== undefined ? 'principal.reuseRetiredId' : 'principal.create',
              {
                subject,
                roles,
                ...(opts.reuseRetiredId !== undefined ? { principalId: opts.reuseRetiredId } : {}),
              },
            );
        if (emit.machine) emit.ok(result);
        else output.write(`Created principal '${result.principal.id}'.\n`);
      } catch (error) {
        emit.fail(error);
      }
    });

  principal
    .command('bind-native-owner')
    .argument('<node-principal-id>')
    .requiredOption('--owner <principal-id>')
    .option('--offline', 'operate on the store while every gateway is stopped')
    .action(
      async (nodePrincipalId: string, opts: { owner: string; offline?: boolean }, cmd: Command) => {
        const { output, client } = resolveContext(cmd);
        const emit = createEmitter(output, cmd);
        try {
          const result: PrincipalBindNativeOwnerResult = opts.offline
            ? { principal: offlineWriter().bindNativeOwner(nodePrincipalId, opts.owner) }
            : await client.call('principal.bindNativeOwner', {
                nodePrincipalId,
                ownerPrincipalId: opts.owner,
              });
          if (emit.machine) emit.ok(result);
          else output.write(`Bound native owner '${opts.owner}' to '${result.principal.id}'.\n`);
        } catch (error) {
          emit.fail(error);
        }
      },
    );

  principal
    .command('list')
    .option('--offline', 'operate on the store while every gateway is stopped')
    .action(async (opts: { offline?: boolean }, cmd: Command) => {
      const { output, client } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result: PrincipalListResult = opts.offline
          ? { principals: readCredentialStoreOffline(process.env).principals }
          : await client.call('principal.list', {});
        if (emit.machine) emit.ok(result);
        else {
          for (const entry of result.principals) {
            output.write(
              `${entry.id}\t${entry.subject.displayName}\t${entry.subject.type}\t${formatRoles(entry.roles)}\n`,
            );
          }
        }
      } catch (error) {
        emit.fail(error);
      }
    });

  principal
    .command('retire')
    .argument('<principal-ids...>')
    .description('Retire principals after their credentials are revoked')
    .option('--offline', 'operate on the store while every gateway is stopped')
    .action(async (principalIds: string[], opts: { offline?: boolean }, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const emit = createEmitter(output, cmd);
      try {
        const result: PrincipalRetireResult = opts.offline
          ? retirePrincipalsOffline(principalIds)
          : await resolveContext(cmd).client.call('principal.retire', { principalIds });
        if (emit.machine) emit.ok(result);
        else output.write(`Retired ${result.principalIds.join(', ')}.\n`);
      } catch (error) {
        emit.fail(error);
      }
    });

  principal
    .command('grant')
    .argument('<principal-id>')
    .requiredOption('--role <role>', 'admin or operator')
    .requiredOption('--scope <scope>', 'global')
    .option('--offline', 'operate on the store while every gateway is stopped')
    .action(
      async (
        principalId: string,
        opts: { role: Role; scope: string; offline?: boolean },
        cmd: Command,
      ) => {
        const { output, client } = resolveContext(cmd);
        const emit = createEmitter(output, cmd);
        try {
          const role = requiredRole(opts.role);
          const scope = requiredScope(opts.scope);
          const result: PrincipalGrantResult = opts.offline
            ? { principal: offlineWriter().grantRole(principalId, role, scope) }
            : await client.call('principal.grant', { principalId, role, scope });
          if (emit.machine) emit.ok(result);
          else output.write(`Granted ${role}, global to '${result.principal.id}'.\n`);
        } catch (error) {
          emit.fail(error);
        }
      },
    );

  principal
    .command('revokeRole')
    .argument('<principal-id>')
    .requiredOption('--role <role>', 'admin or operator')
    .requiredOption('--scope <scope>', 'global')
    .option('--offline', 'operate on the store while every gateway is stopped')
    .action(
      async (
        principalId: string,
        opts: { role: Role; scope: string; offline?: boolean },
        cmd: Command,
      ) => {
        const { output, client } = resolveContext(cmd);
        const emit = createEmitter(output, cmd);
        try {
          const role = requiredRole(opts.role);
          const scope = requiredScope(opts.scope);
          const result: PrincipalRevokeRoleResult = opts.offline
            ? { principal: offlineWriter().revokeRole(principalId, role, scope) }
            : await client.call('principal.revokeRole', { principalId, role, scope });
          if (emit.machine) emit.ok(result);
          else output.write(`Revoked ${role}, global from '${result.principal.id}'.\n`);
        } catch (error) {
          emit.fail(error);
        }
      },
    );
}

function subjectFromOptions(opts: PrincipalCreateOptions): PrincipalSubject {
  if (opts.nativeOwner !== undefined && opts.type !== 'node')
    throw Object.assign(new Error('--native-owner requires a node principal'), {
      code: 'INVALID_PARAMS',
    });
  if (opts.type === 'person' || opts.type === 'service') {
    return { type: opts.type, displayName: opts.name };
  }
  if (opts.type === 'node' && opts.machine) {
    return {
      type: 'node',
      displayName: opts.name,
      machine: opts.machine,
      ...(opts.nativeOwner !== undefined ? { nativeOwnerPrincipalId: opts.nativeOwner } : {}),
    };
  }
  throw Object.assign(new Error('node principals require --machine'), { code: 'INVALID_PARAMS' });
}

function rolesFromOptions(roles: Role[] | undefined): RoleBinding[] {
  return (roles ?? []).map((role) => ({ role: requiredRole(role), scope: { kind: 'global' } }));
}

function requiredRole(value: string): Role {
  if (value !== 'admin' && value !== 'operator') {
    throw Object.assign(new Error('--role must be admin or operator'), { code: 'INVALID_PARAMS' });
  }
  return value;
}

function requiredScope(value: string): { kind: 'global' } {
  if (value !== 'global') {
    throw Object.assign(new Error('--scope must be global'), { code: 'INVALID_PARAMS' });
  }
  return { kind: 'global' };
}

function formatRoles(roles: RoleBinding[]): string {
  return roles.length
    ? roles.map((binding) => `${binding.role}:${binding.scope.kind}`).join(',')
    : 'none';
}

function offlineWriter(): CredentialStoreWriter {
  return new CredentialStoreWriter(new CredentialStoreRuntime(process.env), true);
}
