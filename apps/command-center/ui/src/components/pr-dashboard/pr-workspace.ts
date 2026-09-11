import type {
  ConfigProjectsResult,
  PRMonitor,
  PRReviewIntent,
  PRReviewObservation,
  PRReviewSubmission,
  PRStatus,
} from '@farmslot/protocol';

import type { GlobalFilters } from '../../state.js';
import { parseHashRoute } from '../../utils/url-state.js';

import type { PRKey } from './pr-board-url-state.js';

export type PRSection = 'prs' | 'reviews' | 'automation';
export type PRScope = 'all' | 'monitored';
export type PRPane = 'overview' | 'monitoring' | 'review';
export interface PRWorkspaceEntry {
  key: PRKey;
  title: string;
  author?: string;
  reviewObservations: PRReviewObservation[];
  project?: string;
  status?: PRStatus;
  monitors: PRMonitor[];
  reviews: PRReviewIntent[];
  requests: PRReviewSubmission[];
}
export function prWorkspaceKey(key: PRKey): string {
  return `${(key.host ?? 'github.com').toLowerCase()}/${key.repo.toLowerCase()}#${key.pr}`;
}
export function prWorkspaceNavigation(hash: string) {
  const { params } = parseHashRoute(hash);
  const oldTab = params.get('prTab');
  const editor = params.get('prEditor');
  const section = params.get('prSection');
  const pane = params.get('prPane');
  const scope: PRScope =
    params.get('prScope') === 'monitored' || (!section && oldTab === 'monitors')
      ? 'monitored'
      : 'all';
  const resolvedSection: PRSection =
    section === 'prs' || section === 'reviews' || section === 'automation'
      ? section
      : ['rules', 'policies', 'attention'].includes(oldTab ?? '') ||
          ['team', 'rule', 'policy'].includes(editor ?? '')
        ? 'automation'
        : oldTab === 'reviews' || editor === 'request'
          ? 'reviews'
          : 'prs';
  return {
    section: resolvedSection,
    scope,
    pane: (pane === 'overview' || pane === 'monitoring' || pane === 'review'
      ? pane
      : resolvedSection === 'reviews'
        ? 'review'
        : scope === 'monitored' || editor === 'monitor' || editor === 'repair'
          ? 'monitoring'
          : 'overview') as PRPane,
    history: params.get('prHistory') === '1',
  };
}

export function buildPRWorkspaceEntries(
  statuses: PRStatus[],
  monitors: PRMonitor[],
  reviews: PRReviewIntent[],
  requests: PRReviewSubmission[],
  projects: ConfigProjectsResult['projects'],
  filters: GlobalFilters,
  history: boolean,
  details: PRStatus[] = [],
): PRWorkspaceEntry[] {
  const entries = new Map<string, PRWorkspaceEntry>();
  const statusByKey = new Map(
    [...details, ...statuses].map((status) => [
      prWorkspaceKey({ repo: status.repo, pr: status.pr }),
      status,
    ]),
  );
  const add = (key: PRKey) => {
    const id = prWorkspaceKey(key);
    let entry = entries.get(id);
    if (!entry) {
      const status = statusByKey.get(id);
      entry = {
        key,
        status,
        author: status?.author,
        reviewObservations: [],
        title: status?.title ?? `${key.repo}#${key.pr}`,
        project: status?.project,
        monitors: [],
        reviews: [],
        requests: [],
      };
      entries.set(id, entry);
    }
    return entry;
  };
  for (const status of statuses)
    if (status.ownedFamily === true) add({ repo: status.repo, pr: status.pr });
  for (const monitor of monitors) {
    if (!history && ['stopped', 'finished'].includes(monitor.lifecycle)) continue;
    const entry = add({
      repo: monitor.config.pr.repo,
      pr: monitor.config.pr.number,
      host: monitor.config.pr.host,
    });
    entry.monitors.push(monitor);
    entry.author ||= monitor.observation?.author;
    entry.project ??= monitor.config.project;
    if (!entry.status && monitor.observation) entry.title = monitor.observation.title;
  }
  for (const review of reviews) {
    if (!history && ['completed', 'failed', 'withdrawn'].includes(review.status)) continue;
    const entry = add({ repo: review.pr.repo, pr: review.pr.number, host: review.pr.host });
    entry.reviews.push(review);
    entry.reviewObservations.push(
      ...review.contributions.flatMap((source) =>
        source.reviewObservation ? [source.reviewObservation] : [],
      ),
    );
    entry.author ||= review.author;
    if (!entry.status && review.title) entry.title = review.title;
    entry.project ??= review.contributions.find((c) => c.project)?.project;
  }
  for (const request of requests) {
    if (!history && request.cancelledAt) continue;
    const pr = request.request.pr;
    add({ repo: pr.repo, pr: pr.number, host: pr.host }).requests.push(request);
  }
  return [...entries.values()].filter((entry) => {
    const matchingProjects = projects.filter(
      (p) =>
        p.ci.repo?.toLowerCase() === entry.key.repo.toLowerCase() &&
        (entry.key.host ?? 'github.com') === 'github.com',
    );
    entry.project ??= matchingProjects.length === 1 ? matchingProjects[0].name : undefined;
    if (filters.projects.length && !filters.projects.includes(entry.project ?? '')) return false;
    const slots = [
      entry.status?.slot,
      ...entry.monitors.flatMap((m) => m.activeRuns?.map((r) => r.slotId) ?? []),
    ].filter((s): s is string => Boolean(s));
    return (
      !filters.machines.length ||
      (slots.length === 0 &&
        Boolean(entry.monitors.length || entry.reviews.length || entry.requests.length)) ||
      slots.some((slot) =>
        filters.machines.some((machine) => slot === machine || slot.startsWith(`${machine}-`)),
      )
    );
  });
}
