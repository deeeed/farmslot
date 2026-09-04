/**
 * CDP probe: Run Detail runner-session rows and the copy actions on them.
 * Usage: node apps/command-center/scripts/cdp.mjs eval run/<runId> --file probes/run-session-command.js
 *
 * Clicks the real "Reopen session" button, which drives the same
 * `run.sessionCommand` round trip an operator triggers. Nothing is injected
 * into component state: the row's liveness label only appears after the gateway
 * answered, so it is the proof the RPC ran through the real UI path.
 *
 * The clipboard write itself is a browser capability, not app logic: Chrome
 * refuses it for a programmatic click in some profiles. The probe records
 * whether the copy landed (`copyBlocked`) but does not require it — a refused
 * clipboard must still leave the liveness on screen and must never render
 * "Copied". Run `cdp.mjs focus <hash>` first to give the copy its best chance.
 *
 * Top-level `return` + IIFE: Prettier accepts it (`allowReturnOutsideFunction`)
 * and `cdp.mjs` stmtForm fallback returns the value.
 */
return (async () => {
  const detail = document.querySelector('run-detail');
  const root = detail?.shadowRoot;
  if (!root) return { ok: false, error: 'run-detail did not render on this route' };

  const section = root.querySelector('[data-testid="run-agent-sessions"]');
  if (!section) {
    return {
      ok: false,
      error: 'no runner-session section — this run has no agent contexts',
      runId: detail.run?.id ?? null,
    };
  }

  const rows = [...section.querySelectorAll('[data-testid^="run-agent-session-"]')]
    .filter((node) => node.classList.contains('agent-session-row'))
    .map((node) => ({
      contextId: node.dataset.testid.replace('run-agent-session-', ''),
      text: node.textContent.replace(/\s+/g, ' ').trim(),
    }));
  // Rows are addressed by contextId: several contexts can share a role, and a
  // role-keyed id would make two reviewers indistinguishable in the DOM.
  const duplicateContextIds = new Set(rows.map((row) => row.contextId)).size !== rows.length;

  const reopen = section.querySelector('[data-testid^="run-agent-session-reopen-"]');
  if (!reopen) return { ok: false, error: 'no reopen button rendered', rows };
  const role = reopen.dataset.testid.replace('run-agent-session-reopen-', '');
  const labelBefore = reopen.textContent.trim();

  reopen.click();

  const deadline = Date.now() + 20000;
  let settled = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const button = section.querySelector(`[data-testid="run-agent-session-reopen-${role}"]`);
    const label = button?.textContent.trim() ?? '';
    const liveness = section.querySelector(`[data-testid="run-agent-session-liveness-${role}"]`);
    const error = section.querySelector(`[data-testid="run-agent-session-error-${role}"]`);
    if (label !== 'Loading…' && (label === 'Copied' || liveness || error)) {
      settled = true;
      break;
    }
  }

  const liveness = section.querySelector(`[data-testid="run-agent-session-liveness-${role}"]`);
  const errorNode = section.querySelector(`[data-testid="run-agent-session-error-${role}"]`);
  const sessionId = section.querySelector(`[data-testid="run-agent-session-id-${role}"]`);
  const labelAfter =
    section.querySelector(`[data-testid="run-agent-session-reopen-${role}"]`)?.textContent.trim() ??
    null;

  // A run with several contexts must resolve each row independently: role-only
  // selection used to hand every same-role reviewer the newest one's session.
  const otherRow = rows.find((candidate) => candidate.contextId !== role);
  let secondRow = null;
  if (otherRow) {
    const otherButton = section.querySelector(
      `[data-testid="run-agent-session-reopen-${otherRow.contextId}"]`,
    );
    if (otherButton) {
      otherButton.click();
      const otherDeadline = Date.now() + 20000;
      while (Date.now() < otherDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const label = section
          .querySelector(`[data-testid="run-agent-session-reopen-${otherRow.contextId}"]`)
          ?.textContent.trim();
        const otherLiveness = section.querySelector(
          `[data-testid="run-agent-session-liveness-${otherRow.contextId}"]`,
        );
        const otherError = section.querySelector(
          `[data-testid="run-agent-session-error-${otherRow.contextId}"]`,
        );
        if (label !== 'Loading…' && (label === 'Copied' || otherLiveness || otherError)) break;
      }
      secondRow = {
        contextId: otherRow.contextId,
        sessionIdShort:
          section
            .querySelector(`[data-testid="run-agent-session-id-${otherRow.contextId}"]`)
            ?.textContent.trim() ?? null,
        liveness:
          section
            .querySelector(`[data-testid="run-agent-session-liveness-${otherRow.contextId}"]`)
            ?.textContent.trim() ?? null,
        settled:
          section
            .querySelector(`[data-testid="run-agent-session-reopen-${otherRow.contextId}"]`)
            ?.textContent.trim() !== 'Loading…',
      };
    }
  }

  // The first row must not have been stranded by the second row's click: the
  // request sequence is keyed per context.
  const firstRowStillSettled =
    section
      .querySelector(`[data-testid="run-agent-session-reopen-${role}"]`)
      ?.textContent.trim() !== 'Loading…';

  const attach = section.querySelector(`[data-testid="run-agent-session-attach-${role}"]`);
  let attachLabelAfter = null;
  if (attach) {
    attach.click();
    const attachDeadline = Date.now() + 20000;
    while (Date.now() < attachDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const label =
        section
          .querySelector(`[data-testid="run-agent-session-attach-${role}"]`)
          ?.textContent.trim() ?? '';
      if (label !== 'Loading…') {
        attachLabelAfter = label;
        break;
      }
    }
  }

  const errorText = errorNode?.textContent.trim() ?? null;
  const copyBlocked = Boolean(errorText && /Clipboard copy failed/.test(errorText));
  return {
    // The gateway answered through the real button, the row shows its proved
    // liveness, and a blocked clipboard never masquerades as a copy.
    ok:
      settled &&
      !duplicateContextIds &&
      Boolean(liveness) &&
      Boolean(sessionId?.textContent.trim()) &&
      (labelAfter === 'Copied' || copyBlocked) &&
      firstRowStillSettled &&
      (secondRow === null ||
        (secondRow.settled && secondRow.sessionIdShort !== sessionId?.textContent.trim())),
    runId: detail.run?.id ?? null,
    contextId: role,
    rowCount: rows.length,
    duplicateContextIds,
    rows,
    labelBefore,
    labelAfter,
    attachLabelAfter,
    copyBlocked,
    secondRow,
    firstRowStillSettled,
    sessionIdShort: sessionId?.textContent.trim() ?? null,
    liveness: liveness?.textContent.trim() ?? null,
    error: errorText,
  };
})();
