import type { PRProjectCatalog, PRTeamConfig, PRTriggerRuleConfig } from '@farmslot/protocol';

export interface PRTeamEditorDraft {
  config: PRTeamConfig;
  sections: string[];
  catalogs: PRProjectCatalog[];
  importURL: string;
  sourceMode: 'farm' | 'project';
  selectedFarm: string;
}
export interface PRRuleEditorDraft {
  config: PRTriggerRuleConfig;
  repository: string;
}
export type PRFormDraft =
  | { kind: 'team'; value: PRTeamEditorDraft }
  | { kind: 'rule'; value: PRRuleEditorDraft };
export interface PRStoredDraft {
  version: 1;
  payload: PRFormDraft;
  target?: string;
  revision?: number;
}
export function prDraftScope(gatewayUrl: string, principalId: string | null): string | null {
  if (!principalId) return null;
  const url = new URL(gatewayUrl);
  return JSON.stringify([url.origin, url.pathname, principalId]);
}
function key(scope: string, id: string) {
  return `farmslot:pr-draft:${scope}:${id}`;
}
export function readPRDraft(
  storage: Pick<Storage, 'getItem'>,
  scope: string,
  id: string,
): PRStoredDraft | null {
  const text = storage.getItem(key(scope, id));
  if (!text) return null;
  let result: PRStoredDraft;
  try {
    result = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (result?.version !== 1 || !result.payload?.value?.config) return null;
  if (
    result.target !== undefined &&
    (typeof result.target !== 'string' ||
      !Number.isSafeInteger(result.revision) ||
      result.revision! < 1)
  )
    return null;
  const p = result.payload;
  if (
    p.kind === 'team' &&
    (!p.value.config.account ||
      typeof p.value.config.account.host !== 'string' ||
      typeof p.value.config.account.login !== 'string' ||
      typeof p.value.config.name !== 'string' ||
      !Array.isArray(p.value.config.sources) ||
      !Array.isArray(p.value.config.repositories) ||
      !Array.isArray(p.value.sections) ||
      !Array.isArray(p.value.catalogs))
  )
    return null;
  if (p.kind === 'rule' && !Array.isArray(p.value.config.actions)) return null;
  return p.kind === 'team' || p.kind === 'rule' ? result : null;
}
export function writePRDraft(
  storage: Pick<Storage, 'setItem'>,
  scope: string,
  id: string,
  value: PRStoredDraft,
) {
  storage.setItem(key(scope, id), JSON.stringify(value));
}
export function removePRDraft(storage: Pick<Storage, 'removeItem'>, scope: string, id: string) {
  storage.removeItem(key(scope, id));
}

export function createPRDraftId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
