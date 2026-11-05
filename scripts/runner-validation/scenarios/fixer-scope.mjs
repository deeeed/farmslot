import assert from 'node:assert/strict';
export async function runScenario(c) {
  await c.start({
    scripted: {
      mode: 'scenario',
      scenario: 'late-ack',
      stepDelayMs: 1,
      promptScenario: 'edit-forbidden-file',
    },
    flowType: 'pr-complete',
    mode: 'autonomous',
    devInteractiveProfile: undefined,
    ticketOrPr: 'fixture/recovery#102',
    prNumber: 102,
  });
  await c.wait('ci-watch fixer starts', (run) =>
    run.agentContexts?.some((context) => context.role === 'ci-fix'),
  );
  const run = await c.wait('forbidden edit is reported', (run) => {
    const blocked = run.decisions.find(
      (decision) => !decision.resolvedAt && decision.type === 'ci_inline_fix_blocked',
    );
    if (blocked) {
      assert.match(blocked.description, /forbidden|workflow|scope/i);
      return true;
    }
    if (
      run.agentContexts?.some(
        (context) => context.role === 'ci-fix' && context.status === 'complete',
      )
    ) {
      assert.equal(
        c.git('show', '--format=', '--name-only', 'HEAD'),
        '.github/workflows/scripted.yml',
      );
      throw new Error('F415: CI fixer accepted a forbidden workflow edit without a scope refusal');
    }
    return false;
  });
  assert.ok(run.decisions.some((decision) => decision.type === 'ci_inline_fix_blocked'));
}
