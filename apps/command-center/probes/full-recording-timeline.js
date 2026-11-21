// Run with cdp.mjs eval --file on a retained run's open Evidence review.
return await (async () => {
  function find(root, selector) {
    for (const element of root.querySelectorAll('*')) {
      if (element.matches(selector)) return element;
      const match = element.shadowRoot && find(element.shadowRoot, selector);
      if (match) return match;
    }
  }
  async function waitFor(read, ms) {
    const until = Date.now() + ms;
    do {
      const result = read();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < until);
    throw new Error('Expected evidence review content did not appear');
  }
  const reviewer = await waitFor(() => {
    const candidate = find(document, 'evidence-reviewer');
    const disclosure = candidate?.shadowRoot?.querySelector('[data-testid="recording-timeline"]');
    if (disclosure) return candidate;
  }, 22000);
  const modal = document
    .querySelector('whats-new-modal')
    ?.shadowRoot?.querySelector('button.primary');
  modal?.click();
  const disclosure = reviewer.shadowRoot.querySelector('[data-testid="recording-timeline"]');
  const closedRows = disclosure.querySelectorAll('button[data-trace-index]').length;
  if (!disclosure.open) disclosure.querySelector('summary').click();
  const buttons = await waitFor(() => {
    const rows = [...disclosure.querySelectorAll('button[data-trace-index]')];
    return rows.length ? rows : null;
  }, 5000);
  let startedFromStill = false;
  const still = reviewer.shadowRoot.querySelector('button.still:not(.still-video)');
  if (still) {
    still.click();
    await waitFor(
      () =>
        reviewer.shadowRoot.querySelector('button.still:not(.still-video)[aria-pressed="true"]'),
      5000,
    );
    startedFromStill = true;
  }
  const model = reviewer.selection.model;
  const path = reviewer.selection.recording.path;
  const source = model.recordingTimelineForPath(path);
  if (!source?.current || !source.timeline)
    throw new Error('Open a measured recording from the selected execution');
  const proofIndexes = new Set(
    model.currentOccurrences
      .filter((row) => row.proves.includes(reviewer.selection.claimId))
      .map((row) => row.traceIndex),
  );
  const first = buttons.find(
    (button) => !button.disabled && !proofIndexes.has(Number(button.dataset.traceIndex)),
  );
  if (!first)
    throw new Error('Open a recording with a measured step outside the selected AC proof');
  const { timeline } = source;
  const expected = model.markerSeekMs(
    timeline.videoPath,
    Number(first.dataset.traceIndex),
    'start',
  );
  const player = find(reviewer.shadowRoot, 'media-lightbox');
  if (!player?.shadowRoot) throw new Error('Evidence player missing');
  const video = find(player.shadowRoot, 'video');
  video?.pause();
  if (video && Math.abs(video.currentTime * 1000 - expected) <= 2)
    throw new Error('Video already at the test step');
  let observed;
  const observe = (event) => {
    const video = event.target;
    if (video instanceof HTMLVideoElement && Math.abs(video.currentTime * 1000 - expected) <= 2)
      observed = { value: video.currentTime };
  };
  player.shadowRoot.addEventListener('seeked', observe, true);
  try {
    first.click();
    await waitFor(() => observed, 12000);
    await reviewer.updateComplete;
  } finally {
    player.shadowRoot.removeEventListener('seeked', observe, true);
  }
  return {
    route: location.hash,
    requiresRecipeGroup: reviewer.selection.allowHistoricalTimeline === true,
    path,
    videoDigest: timeline.videoDigest,
    recordingRevision: [timeline.videoDigest, model.recordingForPath(path)?.timelineDigest]
      .filter(Boolean)
      .join('.'),
    traceDigest: timeline.traceDigest,
    markerCount: timeline.markers.length,
    indexHasVerifiedRevision: !!reviewer.timeline?.projection?.revision,
    recordingOptions: model.recordings.map(({ videoPath, videoDigest }) => ({
      videoPath,
      videoDigest,
    })),
    closedRows,
    startedFromStill,
    rows: buttons.map((button) => ({
      index: Number(button.dataset.traceIndex),
      seek: !button.disabled,
      text: button.innerText,
    })),
    seek: {
      index: Number(first.dataset.traceIndex),
      expectedMs: expected,
      observedMs: observed.value * 1000,
    },
    proofRows: reviewer.shadowRoot.querySelectorAll('.step-row').length,
    viewport: [innerWidth, innerHeight],
    pageErrors: window.timelineProofErrors ?? null,
  };
})();
