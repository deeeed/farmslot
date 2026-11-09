// The run evidence page: a default layout of sections over the shared view-model, and the
// template contract a project uses to reorder, add or replace sections, or the whole body.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  RunEvidenceCue,
  RunEvidenceFile,
  RunEvidenceView,
} from '@farmslot/adapter-sdk/evidence';
import { isRecord } from '@farmslot/protocol';

import type { RunEvidenceHistoryEntry } from './evidence-view.js';

export interface RunEvidencePageContext {
  /** URL of one of this run's files, for `<img>`, `<video>` and links. */
  fileUrl(path: string): string;
  /** URL of another run in the history. */
  runUrl(id: string): string;
  escape(value: unknown): string;
  /** `m:ss.cc`, the player's timecode. */
  formatMs(ms: number): string;
  /** Attributes that make any element seek the page's player to `cue` on click. */
  seekAttributes(cue: RunEvidenceCue): string;
  history: readonly RunEvidenceHistoryEntry[];
}

export interface RunEvidenceSection {
  id: string;
  render(view: RunEvidenceView, context: RunEvidencePageContext): string;
}

/**
 * A project's page over the same view-model. Every member is optional; a template that
 * sets none renders the default page unchanged.
 */
export interface RunEvidenceTemplate {
  /** Reorder, drop, replace or add sections; receives the default ones in page order. */
  sections?(defaults: readonly RunEvidenceSection[]): readonly RunEvidenceSection[];
  /** The whole page body instead of sections; the shell keeps its player and live script. */
  page?(view: RunEvidenceView, context: RunEvidencePageContext): string;
  /** CSS appended after the default styles. */
  styles?: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/gu, (char) => ESCAPES[char]!);
}

const verdictClass = (verdict: string | null) =>
  verdict === 'proven' || verdict === 'pass'
    ? 'ok'
    : verdict === 'failed' || verdict === 'fail'
      ? 'bad'
      : verdict === 'running'
        ? 'live'
        : 'wait';

function badge(label: string, tone: string): string {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function fileItem(file: RunEvidenceFile, context: RunEvidencePageContext): string {
  const url = context.escape(context.fileUrl(file.path));
  const name = context.escape(file.name);
  return file.mediaType === 'image'
    ? `<a class="still" href="${url}" target="_blank" rel="noreferrer"><img src="${url}" alt="${name}" loading="lazy"></a>`
    : `<a class="doc" href="${url}" target="_blank" rel="noreferrer">${name}</a>`;
}

function playButton(cue: RunEvidenceCue | null, context: RunEvidencePageContext): string {
  return cue
    ? `<button type="button" class="play" ${context.seekAttributes(cue)}>▶ ${context.formatMs(cue.startMs)}</button>`
    : '';
}

const header: RunEvidenceSection = {
  id: 'header',
  render(view, context) {
    const run = view.run;
    const counts = Object.entries(view.summary)
      .filter(([key, count]) => key !== 'total' && count > 0)
      .map(([key, count]) => badge(`${count} ${key}`, verdictClass(key)))
      .join(' ');
    return `<header class="run-header">
  <div class="title-row"><h1>${context.escape(run?.title ?? run?.id ?? 'Recipe run')}</h1>${run ? badge(run.status, verdictClass(run.status)) : ''}</div>
  <p class="meta">${[
    run?.id,
    run?.startedAt,
    run?.durationMs !== undefined ? `${(run.durationMs / 1000).toFixed(1)} s` : undefined,
  ]
    .filter(Boolean)
    .map((part) => context.escape(part))
    .join(' · ')}</p>
  <p class="counts">${view.summary.total} criteria ${counts}</p>
  <nav class="modes" aria-label="View"><a href="#story" data-mode-link="story">Story</a><a href="#" data-mode-link="evidence">Evidence</a></nav>
</header>`;
  },
};

const player: RunEvidenceSection = {
  id: 'player',
  render(view, context) {
    if (!view.videos.length)
      return `<section class="player"><p class="empty">${view.run?.status === 'running' ? 'The recording appears when the run ends.' : 'This run kept no recording.'}</p></section>`;
    return `<section class="player">${view.videos
      .map(
        (video) =>
          `<figure><video controls preload="metadata" data-video-path="${context.escape(video.path)}" src="${context.escape(context.fileUrl(video.path))}"></video>${video.measured ? '' : '<figcaption>No measured timeline: it plays, but no claim or step seeks into it.</figcaption>'}</figure>`,
      )
      .join('')}</section>`;
  },
};

const criteria: RunEvidenceSection = {
  id: 'criteria',
  render(view, context) {
    if (!view.criteria.length)
      return '<section class="criteria"><h2>Acceptance criteria</h2><p class="empty">This run declares no criteria.</p></section>';
    const rows = view.criteria.map((criterion) => {
      const steps = criterion.traceIndexes
        .map((index) => `<a href="#step-${index}">#${index}</a>`)
        .join(' ');
      const pair = criterion.pair
        ? `<div class="pair"><figure><figcaption>Before</figcaption>${fileItem(criterion.pair.before, context)}</figure><figure><figcaption>After</figcaption>${fileItem(criterion.pair.after, context)}</figure></div>`
        : '';
      const paired = new Set(
        criterion.pair ? [criterion.pair.before.path, criterion.pair.after.path] : [],
      );
      const files = criterion.files.filter((file) => !paired.has(file.path));
      return `<li class="criterion${criterion.parentId ? ' child' : ''}" id="criterion-${context.escape(criterion.id)}">
  <div class="row"><code>${context.escape(criterion.id)}</code>${badge(criterion.verdictLabel, verdictClass(criterion.verdict))}${playButton(criterion.cue, context)}</div>
  <p>${context.escape(criterion.text)}</p>
  ${criterion.note ? `<p class="note">${context.escape(criterion.note)}</p>` : ''}
  ${pair}
  ${files.length ? `<div class="files">${files.map((file) => fileItem(file, context)).join('')}</div>` : ''}
  ${steps ? `<p class="steps">Proved by ${steps}</p>` : ''}
</li>`;
    });
    return `<section class="criteria"><h2>Acceptance criteria</h2><ol>${rows.join('')}</ol></section>`;
  },
};

const timeline: RunEvidenceSection = {
  id: 'timeline',
  render(view, context) {
    if (!view.steps.length) return '';
    const rows = view.steps.map(
      (step) => `<li id="step-${step.traceIndex}" class="${step.ok ? '' : 'failed'}">
  <span class="index">${step.traceIndex}</span>${badge(step.ok ? 'pass' : 'fail', step.ok ? 'ok' : 'bad')}
  <span class="intent">${context.escape(step.intent || step.nodeId)}</span>
  <code>${context.escape(step.nodeId)}</code>
  ${step.proves.map((id) => `<a class="chip" href="#criterion-${context.escape(id)}">${context.escape(id)}</a>`).join('')}
  ${playButton(step.cue, context)}
</li>`,
    );
    return `<section class="timeline"><h2>Timeline</h2><ol>${rows.join('')}</ol></section>`;
  },
};

/** Every executed intent in run order, read top to bottom; a measured step seeks the player. */
const story: RunEvidenceSection = {
  id: 'story',
  render(view, context) {
    if (!view.steps.length)
      return `<section class="story"><h2>Story</h2><p class="empty">${view.run?.status === 'running' ? 'No step has finished yet.' : 'This run recorded no steps.'}</p></section>`;
    const rows = view.steps.map((step) => {
      const line = `<span class="at">${step.atMs === null ? '' : context.escape(context.formatMs(step.atMs))}</span>${badge(step.ok ? 'pass' : 'fail', step.ok ? 'ok' : 'bad')}<span class="intent">${context.escape(step.intent || step.nodeId)}</span>`;
      const stills = step.files.filter((file) => file.mediaType === 'image');
      return `<li class="${step.ok ? '' : 'failed'}" data-trace-index="${step.traceIndex}">${
        step.cue
          ? `<button type="button" class="beat" ${context.seekAttributes(step.cue)}>${line}</button>`
          : `<div class="beat">${line}</div>`
      }${stills.length ? `<div class="files">${stills.map((file) => fileItem(file, context)).join('')}</div>` : ''}</li>`;
    });
    return `<section class="story"><h2>Story</h2><ol>${rows.join('')}</ol></section>`;
  },
};

const history: RunEvidenceSection = {
  id: 'history',
  render(view, context) {
    if (context.history.length < 2) return '';
    return `<section class="history"><h2>Run history</h2>${historyList(context.history, context, view.run?.id)}</section>`;
  },
};

const issues: RunEvidenceSection = {
  id: 'issues',
  render(view, context) {
    const lines = [...view.errors, ...view.warnings];
    if (!lines.length) return '';
    return `<section class="issues"><details${view.errors.length ? ' open' : ''}><summary>${view.errors.length} errors, ${view.warnings.length} warnings</summary><ul>${lines
      .map((line) => `<li>${context.escape(line)}</li>`)
      .join('')}</ul></details></section>`;
  },
};

/** The default page, in order. */
export const DEFAULT_RUN_EVIDENCE_SECTIONS: readonly RunEvidenceSection[] = Object.freeze([
  header,
  issues,
  player,
  criteria,
  story,
  timeline,
  history,
]);

function historyList(
  entries: readonly RunEvidenceHistoryEntry[],
  context: Pick<RunEvidencePageContext, 'escape' | 'runUrl'>,
  current?: string,
): string {
  return `<ul class="run-list">${entries
    .map(
      (entry) =>
        `<li${entry.id === current ? ' class="current"' : ''}><a href="${context.escape(context.runUrl(entry.id))}">${context.escape(entry.title ?? entry.id)}</a> ${badge(entry.status, verdictClass(entry.status))}<span class="meta">${context.escape(entry.id)} · ${context.escape(entry.startedAt ?? entry.updatedAt)}</span></li>`,
    )
    .join('')}</ul>`;
}

const STYLES = `
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--fg:#1c1c1a;--muted:#6b6b66;--line:#e2e2dc;--ok:#1f7a3f;--bad:#b42318;--wait:#8a6100;--live:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--fg:#ecece6;--muted:#9a9a92;--line:#33332f;--ok:#4ade80;--bad:#f87171;--wait:#fbbf24;--live:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px 64px;display:grid;gap:16px;grid-template-columns:minmax(0,1fr)}
@media (min-width:1000px){main{grid-template-columns:minmax(0,7fr) minmax(0,5fr)}.run-header,.issues,.timeline,.history{grid-column:1/-1}.player{position:sticky;top:16px;align-self:start}}
html[data-mode=story] .criteria,html[data-mode=story] .timeline,html:not([data-mode=story]) .story{display:none}
.modes{display:flex;gap:4px;margin-top:12px}.modes a{font-size:13px;padding:2px 12px;border:1px solid var(--line);border-radius:6px;text-decoration:none;color:var(--muted)}
html:not([data-mode=story]) [data-mode-link=evidence],html[data-mode=story] [data-mode-link=story]{color:var(--fg);border-color:var(--fg);font-weight:600}
.story li{padding:8px 0;border-top:1px solid var(--line)}.story li:first-child{border-top:0;padding-top:0}.story li.failed{background:color-mix(in srgb,var(--bad) 8%,transparent)}
.beat{display:flex;gap:10px;align-items:baseline;width:100%;font:inherit;color:inherit;background:none;border:0;padding:0;text-align:left}button.beat{cursor:pointer}button.beat:hover .intent{color:var(--live)}
.beat .at{color:var(--muted);font-variant-numeric:tabular-nums;min-width:5.5em;font-size:12px}.beat .intent{flex:1}
#viewer-status{position:fixed;left:16px;bottom:16px;margin:0;padding:8px 12px;border-radius:8px;background:var(--card);border:1px solid var(--bad);color:var(--bad);font-size:13px}
section,header{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 12px}.title-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.meta{color:var(--muted);font-size:12px;margin:4px 0}.counts{margin:8px 0 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 8px;font-size:12px;line-height:20px;white-space:nowrap}
.badge.ok{color:var(--ok)}.badge.bad{color:var(--bad)}.badge.wait{color:var(--wait)}.badge.live{color:var(--live)}
video{width:100%;border-radius:6px;background:#000;display:block}.player figure{margin:0}.player figure+figure{margin-top:8px}.player figcaption{font-size:12px;color:var(--muted);margin-top:4px}
ol,ul{margin:0;padding:0;list-style:none}.criterion{padding:12px 0;border-top:1px solid var(--line)}.criterion:first-child{border-top:0;padding-top:0}
.criterion.child{margin-left:20px}.criterion p{margin:6px 0}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.note{color:var(--muted)}.steps{font-size:12px;color:var(--muted)}a{color:var(--live)}
.play{font:inherit;font-size:12px;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:6px;padding:1px 8px;cursor:pointer;margin-left:auto}
.play:hover{border-color:var(--live);color:var(--live)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}.pair figure{margin:0}.pair figcaption{font-size:12px;color:var(--muted)}
.files{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.still img{max-width:100%;max-height:220px;border:1px solid var(--line);border-radius:4px;display:block}
.pair .still img{max-height:none;width:100%}.files .still img{width:160px;height:auto}
.timeline li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--line)}.timeline li:first-child{border-top:0}
.timeline li.failed{background:color-mix(in srgb,var(--bad) 8%,transparent)}.timeline .index{color:var(--muted);font-variant-numeric:tabular-nums;min-width:2.5em;text-align:right}
.timeline .intent{flex:1 1 320px}.timeline code{color:var(--muted);font-size:12px}
.chip{font-size:12px;border:1px solid var(--line);border-radius:4px;padding:0 6px;text-decoration:none}
.run-list li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--line)}.run-list li:first-child{border-top:0}.run-list li.current a{font-weight:600}
.issues summary{cursor:pointer}.issues li{font-size:12px;color:var(--muted);padding:2px 0}.empty{color:var(--muted);margin:0}
`;

// Before paint: `#story` selects the Story view; reload and Back/Forward restore it.
const MODE_SCRIPT = `(function(){var r=document.documentElement;function apply(){r.dataset.mode=location.hash==='#story'?'story':'evidence'}
apply();addEventListener('hashchange',apply);addEventListener('popstate',apply);
document.addEventListener('click',function(e){if(!e.target.closest('[data-mode-link=evidence]'))return;e.preventDefault();
if(location.hash){history.pushState(null,'',location.pathname+location.search);apply()}});})();`;

// Any element with data-seek-video/data-seek-ms seeks the page's player; live pages poll
// their version and reload when the folder changes. Failures show in #viewer-status.
const SCRIPT = `
function note(t){var n=document.getElementById('viewer-status');n.textContent=t;n.hidden=!t}
document.addEventListener('click',function(e){var b=e.target.closest('[data-seek-ms]');if(!b)return;
var path=b.getAttribute('data-seek-video');var v=[].slice.call(document.querySelectorAll('video[data-video-path]')).find(function(x){return x.getAttribute('data-video-path')===path});
if(!v){note('The recording '+path+' is not on this page.');return}var ms=Number(b.getAttribute('data-seek-ms'));
var go=function(){v.currentTime=ms/1000;v.play().catch(function(err){/* A newer seek interrupting play() rejects with AbortError; that seek wins. */if(err.name!=='AbortError')note('Playback failed: '+err.message)})};
v.scrollIntoView({block:'nearest',behavior:'smooth'});if(v.readyState>=1)go();else v.addEventListener('loadedmetadata',go,{once:true});});
(function(){var d=document.body.dataset;if(d.live!=='1')return;setInterval(function(){fetch(d.versionUrl,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text()}).then(function(t){note('');if(t!==d.version)location.reload()}).catch(function(err){note('Lost the viewer server ('+err.message+'); retrying.')})},2000);})();
`;

function shell(
  title: string,
  body: string,
  live: { versionUrl: string; version: string } | null,
  template?: RunEvidenceTemplate,
): string {
  const liveAttributes = live
    ? ` data-live="1" data-version-url="${escapeHtml(live.versionUrl)}" data-version="${escapeHtml(live.version)}"`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><script>${MODE_SCRIPT}</script><style>${STYLES}${template?.styles ?? ''}</style></head>
<body${liveAttributes}><main>${body}</main><p id="viewer-status" role="status" hidden></p><script>${SCRIPT}</script></body></html>
`;
}

export interface RunEvidencePageOptions {
  context: RunEvidencePageContext;
  /** Set while the run is in progress: the page reloads when the signature changes. */
  live?: { versionUrl: string; version: string } | null;
  template?: RunEvidenceTemplate;
}

export function renderRunEvidencePage(
  view: RunEvidenceView,
  options: RunEvidencePageOptions,
): string {
  const { context, template } = options;
  const body = template?.page
    ? template.page(view, context)
    : (template?.sections?.(DEFAULT_RUN_EVIDENCE_SECTIONS) ?? DEFAULT_RUN_EVIDENCE_SECTIONS)
        .map((section) => section.render(view, context))
        .join('\n');
  return shell(
    view.run?.title ?? view.run?.id ?? 'Recipe run',
    body,
    options.live ?? null,
    template,
  );
}

export function renderRunHistoryPage(
  root: string,
  entries: readonly RunEvidenceHistoryEntry[],
  options: Omit<RunEvidencePageOptions, 'context'> & {
    context: Pick<RunEvidencePageContext, 'escape' | 'runUrl'>;
  },
): string {
  const body = `<header class="run-header"><h1>Recipe runs</h1><p class="meta">${escapeHtml(root)}</p></header>
<section class="history">${entries.length ? historyList(entries, options.context) : '<p class="empty">No recipe runs here yet.</p>'}</section>`;
  return shell('Recipe runs', body, options.live ?? null, options.template);
}

/** Import a project's template module: its default export, or its `template` export. */
export async function loadRunEvidenceTemplate(modulePath: string): Promise<RunEvidenceTemplate> {
  const loaded: unknown = await import(pathToFileURL(path.resolve(modulePath)).href);
  const value = isRecord(loaded) ? (loaded.default ?? loaded.template) : undefined;
  if (
    !isRecord(value) ||
    (value.sections !== undefined && typeof value.sections !== 'function') ||
    (value.page !== undefined && typeof value.page !== 'function') ||
    (value.styles !== undefined && typeof value.styles !== 'string')
  )
    throw new Error(
      `${modulePath} must export a run evidence template: { sections?, page?, styles? }.`,
    );
  return value as RunEvidenceTemplate;
}
