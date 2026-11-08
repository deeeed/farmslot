import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { ProjectConfig } from '@farmslot/protocol';

import { ProjectBindingError } from './context-state.js';

type ProviderDeclaration = NonNullable<ProjectConfig['recipe']>['provider'];
interface ProviderEnvironment {
  env: NodeJS.ProcessEnv;
  poolEnv?: Record<string, string>;
  authorizedProviders?: readonly string[];
}

export function resolveProviderModule(declaration: ProviderDeclaration, root: string): string {
  try {
    return declaration.package
      ? createRequire(path.join(root, 'package.json')).resolve(declaration.module)
      : fs.realpathSync(path.resolve(root, declaration.module));
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'MODULE_NOT_FOUND') throw error;
    throw new ProjectBindingError(
      'PROVIDER_MISSING',
      `Provider ${declaration.module} is not available.`,
      'install the configured provider or correct recipe.provider.module',
    );
  }
}

/** Ambient values stay below pool defaults; explicit provider authority selects the given root. */
export function providerEnvironmentRoot(
  declaration: ProviderDeclaration,
  options: ProviderEnvironment,
): string | undefined {
  const variable = declaration.root?.env;
  if (!variable) return undefined;
  const supplied = options.env[variable];
  const authorized = options.authorizedProviders;
  if (
    supplied &&
    authorized?.length &&
    (authorized.includes(declaration.module) ||
      authorized.includes(resolveProviderModule(declaration, supplied)))
  )
    return supplied;
  return options.poolEnv?.[variable];
}
