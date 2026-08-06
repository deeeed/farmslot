const pipelines = [...document.querySelectorAll('dev-harness run-pipeline')];

const inspect = (runId) => {
  const pipeline = pipelines.find((candidate) => candidate.run?.id === runId);
  if (!pipeline?.shadowRoot) throw new Error(`run-pipeline ${runId} did not render`);
  const wrap = pipeline.shadowRoot.querySelector('.pipeline-wrap');
  const statusRow = wrap?.querySelector('.pipeline-status-row');
  const banner = wrap?.querySelector('.review-recovery.operator-required');
  const controls = wrap?.querySelector('.controls');
  const bannerRect = banner?.getBoundingClientRect();
  const controlsRect = controls?.getBoundingClientRect();
  const overlapsControls = Boolean(
    bannerRect &&
    controlsRect &&
    bannerRect.left < controlsRect.right &&
    bannerRect.right > controlsRect.left &&
    bannerRect.top < controlsRect.bottom &&
    bannerRect.bottom > controlsRect.top,
  );
  const children = [...(wrap?.children ?? [])].map(
    (child) => child.className?.baseVal || child.className || child.tagName.toLowerCase(),
  );
  return {
    runId,
    status: pipeline.run?.status ?? null,
    bannerText: banner?.textContent?.trim() ?? null,
    statusRowPresent: Boolean(statusRow),
    controlsPresent: Boolean(controls),
    overlapsControls,
    children,
  };
};

const active = inspect('pipe-blocked');
const inactive = inspect('pipe-completed');
const pass =
  active.bannerText?.includes('Review recovery: operator-required') === true &&
  active.bannerText.includes('Reviewer completed without a valid structured result.') &&
  active.statusRowPresent &&
  active.controlsPresent &&
  !active.overlapsControls &&
  active.children[0] === 'pipeline-status-row' &&
  inactive.bannerText?.includes('Review recovery: operator-required') === true &&
  inactive.bannerText.includes('Historical run requires operator review.') &&
  inactive.statusRowPresent &&
  !inactive.controlsPresent &&
  !inactive.overlapsControls &&
  inactive.children[0] === 'pipeline-status-row';

return { pass, active, inactive };
