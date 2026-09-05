/**
 * CDP probe: the human-gate "the Gateway did not resolve this plan from the
 * choice" warning must not fire for `project-default`, whose whole meaning is to
 * defer to the lower precedence levels, and must still fire for a choice the
 * Gateway really ignored.
 *
 * Usage (the run must be at `operator-wait` with a pending human decision):
 *   node apps/command-center/scripts/cdp.mjs eval run/<runId> \
 *     --file probes/run-posture-gate-choice-honored.js --out <evidence.json>
 *
 * Nothing is injected. The probe clicks the real choice buttons an operator
 * clicks, and the component issues its own `runtime.posture.preview` call; the
 * probe only reads what the Gateway's answer rendered. That matters beyond the
 * no-injection rule: a probe that fed the renderer a plan directly would still
 * pass if selection or preview forwarding were broken.
 *
 * What this probe does NOT cover: the "did not resolve this plan from the
 * choice" warning firing. The Gateway cannot produce that state while the
 * choices are on screen — at an operator wait every non-deferring choice comes
 * back with policy source `gate-choice`, and a deferring one is honoured by
 * definition — so there is no live run that renders it. That render is covered
 * by the unit tests for `postureChoiceHonored`. An earlier version of this file
 * claimed the free-slot rejection guarded it; it does not, because a rejection
 * renders through a different element entirely.
 *
 * Top-level `return` + IIFE: Prettier accepts it (`allowReturnOutsideFunction`)
 * and `cdp.mjs` stmtForm fallback returns the value.
 */
return (async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (node) => node?.textContent.replace(/\s+/g, ' ').trim() ?? null;

  function deepAll(selector, root = document, out = []) {
    out.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) deepAll(selector, element.shadowRoot, out);
    }
    return out;
  }

  const one = (selector) => deepAll(selector)[0] ?? null;

  async function until(description, read, accept, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let latest;
    for (;;) {
      latest = read();
      if (accept(latest)) return latest;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${description}; latest=${JSON.stringify(latest)}`);
      }
      await wait(250);
    }
  }

  // The gate only renders while the Gateway reports the run at operator-wait
  // with a pending decision. If it is absent the run was not staged, and
  // asserting on a missing warning would pass for the wrong reason.
  await until(
    'the posture gate panel to render',
    () => Boolean(one('[data-testid="run-posture-gate"]')),
    (present) => present,
  );

  /**
   * Everything the gate is showing right now, read in one synchronous pass.
   *
   * A run snapshot refresh can clear the selection mid-preview. Reading each
   * element in its own tick let a cleared panel look like "chose minimize, saw
   * no warning" — a pass for the wrong reason. One snapshot makes the selection
   * and the plan verifiably belong together.
   */
  function snapshot(choice) {
    const button = one(`[data-testid="run-posture-choice-${choice}"]`);
    return {
      choice,
      selected: Boolean(button?.classList.contains('selected')),
      loading: Boolean(one('[data-testid="run-posture-preview-loading"]')),
      summary: clean(one('[data-testid="run-posture-preview-summary"]')),
      policySource:
        one('[data-testid="run-posture-preview-summary"]')?.dataset.policySource ?? null,
      honored: one('[data-testid="run-posture-preview-summary"]')?.dataset.choiceHonored ?? null,
      rejectedFlag: one('[data-testid="run-posture-preview-summary"]')?.dataset.rejected ?? null,
      error: clean(one('[data-testid="run-posture-preview-error"]')),
      warningShown: Boolean(one('[data-testid="run-posture-preview-not-honored"]')),
      warningText: clean(one('[data-testid="run-posture-preview-not-honored"]')),
      rejection: clean(one('[data-testid="run-posture-preview-rejection"]')),
    };
  }

  /**
   * Click a real choice button and wait for the component's own preview to land
   * while that choice is still the selected one. The click is retried because a
   * run refresh can drop the selection before the preview returns; a probe that
   * gave up and read anyway would report a blank panel as a clean result.
   */
  async function selectChoice(choice) {
    let last;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const button = one(`[data-testid="run-posture-choice-${choice}"]`);
      if (!button) throw new Error(`no ${choice} button in the rendered gate`);
      if (button.disabled) throw new Error(`the ${choice} button is disabled`);
      if (!button.classList.contains('selected')) button.click();
      try {
        last = await until(
          `the Gateway preview for ${choice}`,
          () => snapshot(choice),
          (state) =>
            state.selected && !state.loading && (state.summary !== null || state.error !== null),
          10000,
        );
        break;
      } catch (error) {
        last = snapshot(choice);
        if (attempt === 3) throw error;
        await wait(500);
      }
    }
    if (last.error) throw new Error(`preview request failed for ${choice}: ${last.error}`);
    // A missing plan is never an answer about the warning.
    if (!last.summary) {
      throw new Error(`${choice} produced no Gateway plan, so nothing about it was proved`);
    }
    return last;
  }

  const results = {};
  const failures = [];

  // Assertions are positive wherever they can be. The panel marks each plan with
  // the Gateway's policy source and whether the selected choice was honoured, so
  // these check what IS rendered rather than only that a warning is absent.
  results['project-default'] = await selectChoice('project-default');
  if (results['project-default'].honored !== 'true') {
    failures.push(
      `project-default was marked honored=${results['project-default'].honored} from policy source ${results['project-default'].policySource}; deferring is what it asks for`,
    );
  }
  if (results['project-default'].policySource === 'gate-choice') {
    failures.push('project-default resolved from the gate choice, so nothing was deferred');
  }
  if (results['project-default'].warningShown) {
    failures.push(
      `project-default warned despite being honoured: ${results['project-default'].warningText}`,
    );
  }

  results.minimize = await selectChoice('minimize');
  if (results.minimize.honored !== 'true' || results.minimize.policySource !== 'gate-choice') {
    failures.push(
      `minimize came back honored=${results.minimize.honored} from ${results.minimize.policySource}; the Gateway resolves it from the choice at an operator wait`,
    );
  }
  if (results.minimize.warningShown) {
    failures.push(`minimize warned about a plan the Gateway resolved from it`);
  }

  // free-slot is the refusal the Gateway really produces here. It is reported by
  // its own element, and the summary must say the refusal changed nothing rather
  // than reading as a harmless empty plan.
  results['free-slot'] = await selectChoice('free-slot');
  if (!results['free-slot'].rejection) {
    failures.push('free-slot was not reported as rejected');
  }
  if (results['free-slot'].rejectedFlag !== 'true') {
    failures.push('the rejected plan was not marked as such on the summary');
  }
  if (!/nothing applied/.test(results['free-slot'].summary ?? '')) {
    failures.push(
      `a refused plan was summarised as "${results['free-slot'].summary}" instead of nothing applied`,
    );
  }

  return { pass: failures.length === 0, failures, results };
})();
