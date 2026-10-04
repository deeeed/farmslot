import { type CdpTargetInfo, retryJsonGet, selectCdpTarget } from './cdp.js';

export interface SelectBrowserExtensionPageTargetOptions {
  host?: string;
  port: number;
  extensionId?: string;
  pathIncludes?: string;
  titleIncludes?: string;
}

export function extensionIdFromTarget(target: Pick<CdpTargetInfo, 'url'>): string | undefined {
  const match = target.url?.match(/^chrome-extension:\/\/([^/]+)/);
  return match?.[1];
}

export async function selectBrowserExtensionPageTarget(
  options: SelectBrowserExtensionPageTargetOptions,
): Promise<CdpTargetInfo> {
  return selectCdpTarget({
    host: options.host,
    port: options.port,
    type: 'page',
    titleIncludes: options.titleIncludes,
    predicate(target) {
      const extensionId = extensionIdFromTarget(target);
      if (!extensionId) return false;
      if (options.extensionId && extensionId !== options.extensionId) return false;
      if (options.pathIncludes && !target.url?.includes(options.pathIncludes)) return false;
      return true;
    },
  });
}

export async function openBrowserExtensionPage(options: {
  host?: string;
  port: number;
  extensionId: string;
  path?: string;
}): Promise<CdpTargetInfo> {
  const host = options.host ?? '127.0.0.1';
  const extensionPath = options.path?.startsWith('/')
    ? options.path.slice(1)
    : (options.path ?? '');
  const url = `chrome-extension://${options.extensionId}/${extensionPath}`;
  const response = await fetch(
    `http://${host}:${options.port}/json/new?${encodeURIComponent(url)}`,
    {
      method: 'PUT',
    },
  );
  if (!response.ok) {
    throw new Error(`Opening extension page ${url} failed with HTTP ${response.status}.`);
  }
  const targets = await retryJsonGet<CdpTargetInfo[]>(`http://${host}:${options.port}/json`);
  const target = targets.find((candidate) => candidate.url === url);
  if (!target) throw new Error(`Opened extension page ${url}, but no CDP target appeared.`);
  return target;
}
