import type { Run, RunTicketData } from '../contracts/runs.js';
import { githubPullUrl, parseGitHubPullUrl, parseGitHubRef } from '../integrations/github-ref.js';

const JIRA_KEY = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const EXACT_JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export interface RunTicketSource {
  ticketOrPr: string;
  ticketData?: RunTicketData;
  linkedTicketRefs?: string[];
  links?: Run['links'];
}

/** Validate operator additions before any metadata write. */
export function normalizeRunLinkedTicketRefs(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('Linked tickets must be a list of Jira keys.');
  const refs: string[] = [];
  for (const value of input) {
    if (typeof value !== 'string') throw new Error('Linked tickets must be Jira keys.');
    const ref = value.trim().toUpperCase();
    if (!EXACT_JIRA_KEY.test(ref)) throw new Error(`Use a Jira key such as TEAM-123: ${value}`);
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** Parse the additional-ticket editor identically on web and native. */
export function parseRunLinkedTicketRefs(draft: string): string[] {
  const text = draft.trim();
  return normalizeRunLinkedTicketRefs(text ? text.split(/[\s,]+/) : []);
}

/** Covered keys, derived without changing the frozen ticket or task inputs. */
export function runLinkedTicketRefs(run: RunTicketSource): string[] {
  const ticket = run.ticketData;
  const values = [
    run.ticketOrPr,
    ticket?.jiraKey,
    ...(ticket?.linkedTickets?.map((t) => t.ref) ?? []),
  ];
  const headingRefs = (ticket?.description ?? '')
    .split('\n')
    .filter((line) => /^\s*(?:#{1,6}\s|h[1-6]\.\s)/.test(line))
    .flatMap((line) => line.match(JIRA_KEY) ?? []);
  const criterionRefs = (ticket?.acceptanceCriteria ?? []).flatMap((criterion) => {
    const prefix = criterion.match(/^\s*(?:AC[- ]?\d+\s*[:.)-]?\s*)?\[?([A-Z][A-Z0-9]*-\d+)\b/);
    return prefix ? [prefix[1]] : [];
  });
  const canonical = values.flatMap((value) =>
    value && EXACT_JIRA_KEY.test(value.toUpperCase()) ? [value.toUpperCase()] : [],
  );
  return [
    ...new Set([...canonical, ...headingRefs, ...criterionRefs, ...(run.linkedTicketRefs ?? [])]),
  ];
}

export interface LinkedRunTicketView {
  ref: string;
  url: string | null;
  operatorAdded: boolean;
}
export interface RunLinkedTicketsView {
  tickets: LinkedRunTicketView[];
  operatorRefs: string[];
  pr: { label: string; url: string } | null;
  references: Pick<LinkedRunTicketView, 'ref' | 'url'>[];
}

/** Thin web/native renderers share ticket identities, destinations and edit values. */
export function runLinkedTicketsView(run: RunTicketSource): RunLinkedTicketsView {
  const operatorRefs = run.linkedTicketRefs ?? [];
  const recorded = run.ticketData?.linkedTickets ?? [];
  const urls = [
    ...recorded.map((ticket) => ticket.url),
    ...(run.links?.map((link) => link.url) ?? []),
  ];
  const browseRoot = urls
    .map((url) => url.match(/^(https?:\/\/[^?#]+\/browse\/)[A-Z][A-Z0-9]*-\d+(?:[?#].*)?$/i)?.[1])
    .find(Boolean);
  const pr = run.links?.find((link) => link.label === 'PR' && /^https?:\/\//.test(link.url));
  const tickets = runLinkedTicketRefs(run).map((ref) => ({
    ref,
    url:
      recorded.find((ticket) => ticket.ref.toUpperCase() === ref && /^https?:\/\//.test(ticket.url))
        ?.url ?? (browseRoot ? `${browseRoot}${ref}` : null),
    operatorAdded: operatorRefs.includes(ref),
  }));
  const sourcePr = parseGitHubRef(run.ticketOrPr) ?? parseGitHubPullUrl(run.ticketOrPr);
  const references: RunLinkedTicketsView['references'] = tickets.map(({ ref, url }) => ({
    ref,
    url,
  }));
  if (sourcePr) references.unshift({ ref: sourcePr.ref, url: githubPullUrl(sourcePr) });
  else if (!tickets.some((ticket) => ticket.ref === run.ticketOrPr.toUpperCase()))
    references.unshift({ ref: run.ticketOrPr, url: null });
  if (pr && !sourcePr) references.push({ ref: 'PR ↗', url: pr.url });
  return {
    tickets,
    operatorRefs,
    pr: pr ? { label: 'PR', url: pr.url } : null,
    references,
  };
}
