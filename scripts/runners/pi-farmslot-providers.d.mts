export class PiModelListFormatError extends Error {}
export function decodePiModelList(output: string): string[];

export interface PiModelCatalog {
  ids: string[];
  aliases: Record<string, string>;
  nativeIds: string[];
  configuredProviders: string[];
}

export function listPiModelCatalog(
  binary: string,
  env?: NodeJS.ProcessEnv,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; args?: string[] },
): Promise<PiModelCatalog>;

export function parsePiProviderDiscovery(
  output: string,
  ids: readonly string[],
): { configuredProviders: string[]; reported: boolean };
export const PI_REQUEST_TIMEOUT_RETRIES: number;

export const PI_CONFIG_ENVIRONMENT: readonly string[];
export function piProviderAuthEnvironment(model: string, env?: NodeJS.ProcessEnv): string[];
