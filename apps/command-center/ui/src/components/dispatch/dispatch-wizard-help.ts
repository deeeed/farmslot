import { html } from 'lit';

export const DISPATCH_HELP = {
  intent: {
    label: 'Dispatch as',
    text: 'New run starts separate work. Comparison sibling tries another configuration against an existing run and groups their results.',
  },
  ticket: {
    label: 'Ticket / PR',
    text: 'Enter an issue ID, pull request number or URL. For Dev, you can describe a new task without a ticket.',
  },
  flow: {
    label: 'Flow',
    text: 'Fix Bug investigates and fixes an issue. Review audits a PR in a workspace without an app slot. QA runs a farm-owned validation profile on runtime slots. Dev implements a task. PR Complete works through the remaining checks and review feedback on an existing PR.',
  },
  project: {
    label: 'Project / App',
    text: 'Project selects the repository configuration and eligible slots. App narrows the target when that project contains several applications.',
  },
  runner: {
    label: 'Runner / Model / Effort',
    text: 'Runner is the installed coding agent and its tools and login. Model is the AI model that agent uses. Effort controls supported reasoning depth; higher settings can take longer and use more tokens. Default uses the configured setting.',
  },
  interface: {
    label: 'Worker interface',
    text: 'Terminal uses the runner’s terminal interface. Conversation shows messages, tools and approvals directly in Farmslot. Native worker support depends on the runner; a disabled choice is unavailable, even if that runner supports standalone conversations.',
  },
  account: {
    label: 'Account profile',
    text: 'Node default account uses the selected machine’s normal runner configuration. A named profile selects another configuration directory on that machine; it is not a different runner or model.',
  },
  prepare: {
    label: 'Prepare',
    text: 'Full Prepare runs the project’s setup before starting the worker. Skip Prepare uses the workspace as it is; choose it only when that slot is already ready. Available preparation profiles come from the project.',
  },
  review: {
    label: 'Review / QA',
    text: 'Review reads source and existing evidence without preparing the app. QA selects a profile from the farm; its skill chooses the checks and runtime evidence. Input overrides are JSON values passed to that skill.',
  },
  interactive: {
    label: 'Interactive dev',
    text: 'Lightweight skips the default self-review and human gate; you finish through task controls. Reviewed enables the normal review checkpoints.',
  },
  slot: {
    label: 'Slots',
    text: 'A slot is a working directory and its execution resources on a machine. Project and capability filters determine which slots can run the task.',
  },
  start: {
    label: 'Dispatch / Queue',
    text: 'Dispatch requests a run now. Queue adds it to the dispatch queue. Both use your selected settings and the project’s admission rules. Unavailable actions show what is missing.',
  },
} as const;

export function renderDispatchHelp() {
  return html`<details class="dispatch-guide" data-testid="dispatch-guide">
    <summary>What do these options mean?</summary>
    <dl tabindex="0" aria-label="Dispatch options guide">
      ${Object.values(DISPATCH_HELP).map(
        ({ label, text }) =>
          html`<div>
            <dt>${label}</dt>
            <dd>${text}</dd>
          </div>`,
      )}
    </dl>
  </details>`;
}
