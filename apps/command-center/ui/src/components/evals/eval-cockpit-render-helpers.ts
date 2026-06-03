import { html, nothing } from 'lit';

import type { EvalCaseCatalogItem } from './eval-suite-helpers.js';

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderEvalPreviewLinks(preview: EvalCaseCatalogItem) {
  const links = [
    ...(preview.prUrl
      ? [
          {
            label: preview.prNumber ? `Open PR #${preview.prNumber}` : 'Open PR',
            href: preview.prUrl,
            external: true,
          },
        ]
      : []),
    ...(preview.runHref
      ? [
          {
            label: `Open run ${preview.runId?.slice(0, 8) ?? ''}`.trim(),
            href: preview.runHref,
            external: false,
          },
        ]
      : []),
    ...(preview.familyHref
      ? [{ label: 'Open evidence / family', href: preview.familyHref, external: false }]
      : []),
    ...(preview.packagePath ? [{ label: 'Package path', href: '', external: false }] : []),
  ];
  if (links.length === 0 && !preview.packagePath) return nothing;
  return html`
    <div class="preview-link-row">
      ${links
        .filter((link) => link.href)
        .map(
          (link) => html`
            <a
              class="preview-link"
              href=${link.href}
              target=${link.external ? '_blank' : nothing}
              rel=${link.external ? 'noopener noreferrer' : nothing}
              >${link.label}</a
            >
          `,
        )}
      ${preview.packagePath ? html`<code>${preview.packagePath}</code>` : nothing}
    </div>
  `;
}

export function renderEvalPreviewStats(preview: EvalCaseCatalogItem) {
  const diff = preview.diffStat;
  return html`
    <div class="preview-stat-grid">
      <div class="preview-stat">
        <strong>${diff ? diff.files : '—'}</strong><span>files edited</span>${diff
          ? html`<small>+${diff.additions} -${diff.deletions}</small>`
          : html`<small>diff not captured</small>`}
      </div>
      <div class="preview-stat">
        <strong>${preview.artifactCount ?? 0}</strong><span>artifacts</span
        ><small>${formatBytes(preview.artifactBytes)}</small>
      </div>
      <div class="preview-stat">
        <strong>${preview.visualEvidenceCount ?? 0}</strong><span>visual evidence</span
        ><small>screens / video</small>
      </div>
      <div class="preview-stat">
        <strong>${preview.validationEvidenceCount ?? 0}</strong><span>validation</span
        ><small>reports / recipes</small>
      </div>
      <div class="preview-stat">
        <strong>${preview.reviewEvidenceCount ?? 0}</strong><span>review</span
        ><small>review / comments</small>
      </div>
    </div>
  `;
}

export function renderProductModelGuide() {
  return html`
    <section class="eval-panel term-panel" aria-label="Eval run model guide">
      <div class="eval-panel-title">Eval model</div>
      <div class="eval-muted">
        Think product-first: choose many cases, try candidate strategies, freeze each trial output
        as a package, then inspect evidence under one rubric per case.
      </div>
      <div class="term-grid">
        <div class="term">
          <strong>Case</strong
          ><span
            >One known PR, run, package, or git ref we want candidates to recreate or improve
            on.</span
          >
        </div>
        <div class="term">
          <strong>Basket</strong
          ><span
            >UI-local set of dataset items. It is not written as a dataset or suite manifest in this
            PR.</span
          >
        </div>
        <div class="term">
          <strong>Candidate strategy</strong
          ><span
            >One planned configuration: template, prompt, harness, base recipe, runner, and
            model.</span
          >
        </div>
        <div class="term">
          <strong>Trial</strong
          ><span>The artifact-only run that executes one candidate strategy for one case.</span>
        </div>
        <div class="term">
          <strong>Result package</strong
          ><span
            >Frozen evidence bundle: diff, visuals, validation, review signals, timing, and
            cost.</span
          >
        </div>
        <div class="term">
          <strong>Operational summary</strong
          ><span
            >Ephemeral launch status: counts, package state, evidence, missing data, and links. It
            does not judge quality.</span
          >
        </div>
        <div class="term">
          <strong>Experiment</strong
          ><span
            >The comparison record for one case. A local suite launch creates many single-case
            experiments.</span
          >
        </div>
        <div class="term">
          <strong>Runtime safety</strong
          ><span
            >No PR mutation. Trials enter the shared dispatch queue before artifact-only eval
            start.</span
          >
        </div>
      </div>
      <div class="boundary-note">
        <div class="eval-panel-title">Dataset and suite boundary</div>
        <ul>
          <li>
            The Reference picker searches hydrated PRs/runs. Manual refs are an explicit alternate
            path, not a second form shown by default.
          </li>
          <li>Each basket item becomes or links to its own single-case experiment.</li>
          <li>
            This local launch foundation keeps only existing experiment/run/package artifacts;
            durable datasets, suite drafts, quality judgments, and external sync are later.
          </li>
          <li>Rubric/judge configuration is future-only; it is not wired into launch.</li>
        </ul>
      </div>
    </section>
  `;
}
