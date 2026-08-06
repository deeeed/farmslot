const pipelines = [...document.querySelectorAll('dev-harness run-pipeline')];

const inspect = (runId) => {
  const pipeline = pipelines.find((candidate) => candidate.run?.id === runId);
  if (!pipeline?.shadowRoot) throw new Error(`run-pipeline ${runId} did not render`);
  const wrap = pipeline.shadowRoot.querySelector('.pipeline-wrap');
  const banner = wrap?.querySelector('.review-recovery.operator-required');
  const controls = wrap?.querySelector('.controls');
  const children = [...(wrap?.children ?? [])].map(
    (child) => child.className?.baseVal || child.className || child.tagName.toLowerCase(),
  );
  return {
    runId,
    status: pipeline.run?.status ?? null,
    bannerText: banner?.textContent?.trim() ?? null,
    controlsPresent: Boolean(controls),
    children,
  };
};

const active = inspect('pipe-blocked');
const inactive = inspect('pipe-completed');
const pass =
  active.bannerText?.includes('Review recovery: operator-required') === true &&
  active.bannerText.includes('Reviewer completed without a valid structured result.') &&
  active.controlsPresent &&
  active.children.indexOf('controls') <
    active.children.indexOf('review-recovery operator-required') &&
  inactive.bannerText?.includes('Review recovery: operator-required') === true &&
  inactive.bannerText.includes('Historical run requires operator review.') &&
  !inactive.controlsPresent &&
  inactive.children[0] === 'review-recovery operator-required';

return { pass, active, inactive };
