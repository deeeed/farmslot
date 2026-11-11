export class PiModelListFormatError extends Error {}
export function parsePiModelList(output: string): string[];

export interface PiModelCatalog {
  ids: string[];
  aliases: Record<string, string>;
  nativeIds: string[];
}

export function listPiModelCatalog(
  binary: string,
  env?: NodeJS.ProcessEnv,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<PiModelCatalog>;
