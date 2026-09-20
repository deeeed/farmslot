import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GatewayCredential {
  token?: string;
  password?: string;
}

export function resolveGatewayCredential(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): GatewayCredential | null {
  const fileEnvironments = findGatewayEnvFiles(env, cwd).map(readEnvFile);
  for (const fileEnv of fileEnvironments) {
    const nodeToken = nonEmpty(fileEnv.FARMSLOT_NODE_TOKEN);
    if (nodeToken) return { token: nodeToken };
  }

  const envCredential = credentialFromEnv(env);
  if (envCredential) return envCredential;

  for (const fileEnv of fileEnvironments) {
    const credential = credentialFromEnv(fileEnv);
    if (credential) return credential;
  }
  return null;
}

function credentialFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string>,
): GatewayCredential | null {
  const token = nonEmpty(env.FARMSLOT_NODE_TOKEN) ?? nonEmpty(env.FARMSLOT_GATEWAY_TOKEN);
  const password = nonEmpty(env.FARMSLOT_GATEWAY_PASSWORD);
  if (token || password) return { ...(token ? { token } : {}), ...(password ? { password } : {}) };
  return null;
}

function findGatewayEnvFiles(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const roots = new Set<string>();
  if (env.FARMSLOT_ROOT) roots.add(resolve(env.FARMSLOT_ROOT));

  let candidate = resolve(cwd);
  while (true) {
    roots.add(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }

  const sourceDir = dirname(fileURLToPath(import.meta.url));
  roots.add(resolve(sourceDir, '../../..'));

  const files: string[] = [];
  for (const root of roots) {
    for (const name of ['.env.local-auth', '.env']) {
      const file = resolve(root, name);
      if (existsSync(file) && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

function readEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eqIdx = normalized.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = normalized.slice(0, eqIdx).trim();
    let value = normalized.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
