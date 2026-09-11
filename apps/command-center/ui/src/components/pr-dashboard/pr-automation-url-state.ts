import { buildHash, parseHashRoute } from '../../utils/url-state.js';

export const PR_AUTOMATION_TABS = [
  'monitors',
  'reviews',
  'rules',
  'policies',
  'attention',
] as const;
export const PR_AUTOMATION_EDITORS = [
  'team',
  'rule',
  'monitor',
  'policy',
  'request',
  'repair',
] as const;
export interface PRAutomationUrlState {
  tab: (typeof PR_AUTOMATION_TABS)[number];
  editor?: (typeof PR_AUTOMATION_EDITORS)[number];
  target?: string;
  draft?: string;
  history: boolean;
}
export function parsePRAutomationUrl(hash: string): PRAutomationUrlState | null {
  const { route, params } = parseHashRoute(hash);
  if (route !== 'prs') return null;
  return {
    tab: PR_AUTOMATION_TABS.find((tab) => tab === params.get('prTab')) ?? 'monitors',
    editor: PR_AUTOMATION_EDITORS.find((editor) => editor === params.get('prEditor')),
    target: params.get('prTarget') || undefined,
    draft: /^[a-zA-Z0-9-]{1,80}$/.test(params.get('prDraft') ?? '')
      ? params.get('prDraft')!
      : undefined,
    history: params.get('prHistory') === '1',
  };
}
export function buildPRAutomationUrl(state: PRAutomationUrlState, hash: string): string | null {
  const { route, params } = parseHashRoute(hash);
  if (route !== 'prs') return null;
  for (const [key, value] of Object.entries({
    prTab: state.tab === 'monitors' ? undefined : state.tab,
    prEditor: state.editor,
    prTarget: state.editor ? state.target : undefined,
    prDraft: state.editor ? state.draft : undefined,
    prHistory: state.history ? '1' : undefined,
  })) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  return buildHash('prs', params);
}
