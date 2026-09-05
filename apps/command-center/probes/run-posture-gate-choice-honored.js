/**
 * CDP probe: the human-gate "the Gateway did not resolve this plan from the
 * choice" warning must fire for a choice the Gateway ignored, and must NOT fire
 * for `project-default`, whose entire meaning is to defer to the lower
 * precedence levels.
 *
 * Usage:
 *   node apps/command-center/scripts/cdp.mjs eval runs \
 *     "window.__posturePlans = <plans json>; return true"
 *   node apps/command-center/scripts/cdp.mjs eval runs \
 *     --file probes/run-posture-gate-choice-honored.js --out <evidence.json>
 *
 * `window.__posturePlans` must hold plans the live Gateway returned from
 * `runtime.posture.preview` for a real run at `operator-wait` — this probe never
 * invents one, because the whole point is what the client does with the
 * Gateway's own policy source. It renders the shipped component through the
 * Vite-served module, so it exercises the deployed code path rather than a
 * local copy of the source.
 *
 * Top-level `return` + IIFE: Prettier accepts it (`allowReturnOutsideFunction`)
 * and `cdp.mjs` stmtForm fallback returns the value.
 */
return (async () => {
  const NOT_HONORED = '[data-testid="run-posture-preview-not-honored"]';
  const plans = window.__posturePlans;
  if (!plans?.['project-default'] || !plans?.minimize) {
    throw new Error('window.__posturePlans must carry live Gateway plans before this probe runs');
  }

  const gate = await import('/src/components/runs/run-detail-posture-gate-renderers.ts');
  // A bare `import('lit')` is not resolved at runtime — Vite only rewrites bare
  // specifiers at transform time. Take the exact URL the app already loaded so
  // this renders with the same lit instance the component was built against.
  const litUrl = performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .find((name) => /\/deps\/lit\.js/.test(name));
  if (!litUrl) throw new Error('the page has not loaded lit, so nothing here would be the real UI');
  const lit = await import(litUrl);

  const host = document.createElement('div');
  host.id = 'posture-gate-probe';
  document.body.appendChild(host);

  function renderChoice(choice) {
    const surface = document.createElement('div');
    host.appendChild(surface);
    lit.render(
      gate.renderRunPostureGateChoices({
        state: {
          choice,
          status: 'ready',
          plan: plans[choice],
          runPosture: 'operator-wait',
        },
        disabled: false,
        onSelect: () => {},
      }),
      surface,
    );
    return {
      choice,
      policySource: plans[choice].policySource,
      // The shipped predicate, taken from the module the browser actually loaded.
      honored: gate.postureChoiceHonored(plans[choice], choice),
      warningShown: Boolean(surface.querySelector(NOT_HONORED)),
      warningText: surface.querySelector(NOT_HONORED)?.textContent.replace(/\s+/g, ' ').trim(),
      summary: surface
        .querySelector('[data-testid="run-posture-preview-summary"]')
        ?.textContent.replace(/\s+/g, ' ')
        .trim(),
    };
  }

  const results = {};
  const failures = [];
  try {
    results['project-default'] = renderChoice('project-default');
    results.minimize = renderChoice('minimize');

    if (results['project-default'].policySource === 'gate-choice') {
      failures.push('the Gateway resolved project-default from the gate choice; nothing to prove');
    }
    if (results['project-default'].warningShown) {
      failures.push('project-default warned even though deferring is exactly what it asked for');
    }
    if (!results['project-default'].honored) {
      failures.push('postureChoiceHonored rejected a deferred project-default plan');
    }
    if (results.minimize.policySource !== 'gate-choice') {
      failures.push(
        `minimize came back from ${results.minimize.policySource}; expected the Gateway to honour it`,
      );
    }
    if (results.minimize.warningShown) {
      failures.push('minimize warned about a plan the Gateway did resolve from the choice');
    }

    // The warning must still fire for a plan the Gateway did NOT resolve from a
    // non-deferring choice, or this probe would pass with the warning deleted.
    const ignored = {
      ...plans.minimize,
      policySource: results['project-default'].policySource,
    };
    const ignoredSurface = document.createElement('div');
    host.appendChild(ignoredSurface);
    lit.render(
      gate.renderRunPostureGateChoices({
        state: { choice: 'minimize', status: 'ready', plan: ignored, runPosture: 'operator-wait' },
        disabled: false,
        onSelect: () => {},
      }),
      ignoredSurface,
    );
    results.ignoredChoice = {
      choice: 'minimize',
      policySource: ignored.policySource,
      warningShown: Boolean(ignoredSurface.querySelector(NOT_HONORED)),
    };
    if (!results.ignoredChoice.warningShown) {
      failures.push('an ignored non-deferring choice did not warn, so the warning is dead');
    }
  } finally {
    host.remove();
  }

  return { pass: failures.length === 0, failures, results };
})();
