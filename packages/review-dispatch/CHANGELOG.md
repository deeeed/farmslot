# Changelog

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.2.5 - 2026-10-18

- Align with `@farmslot/adapter-sdk` 0.18.5.

## 0.2.4 - 2026-10-18

- Align with `@farmslot/adapter-sdk` 0.18.4.

## 0.2.3 - 2026-10-18

- Align with `@farmslot/adapter-sdk` 0.18.3.

## 0.2.2 - 2026-10-18

- Align with `@farmslot/protocol` 0.55.0 and `@farmslot/adapter-sdk` 0.18.2.

## 0.2.1 - 2026-10-17

- Share the run results card summary, the acceptance tally, report link resolution, the web-link check and the artifact HTML policy, so Command Center and Companion show the same results for a run's retained output and open the same artifact from a report link. A review-workspace run shows no results card.
- Align with `@farmslot/adapter-sdk` 0.18.1 and `@farmslot/recipe-runner` 0.39.1 (network capture summaries redact credential-like path segments).

## 0.2.0 - 2026-10-17

- Make Send back to agent the gate's one primary action when offered, with recovery status and earlier-proof row details.
- Withhold publication approval while review findings or a fix remain unresolved, and show the shared review status until the fixed head passes review.
- Share the gateway no-code-review warning without disabling publication approval.
- Share declared gate criteria across client loading layouts.
- Share publication decision status, AC judgment rows and attestation availability across operator clients.
- Use gateway device-session expiry in clients instead of the temporary local sign-in lifetime.
- Document modelPickerState as the renderer API and remove the unused modelChoices method.
- Share model filtering and custom-model detection between the web and native execution pickers.
- Share compact checklist-progress presentation across operator views.
- Share client sign-in expiry and sign-out confirmation across operator apps.
- Resolve review mode once across explicit selections, recorded run/PR options and project defaults.
- Keep project review policy fields out of review selections while preserving configured defaults.
- Add shared review and dispatch selection state, capability defaults, strict validators and ordered request serialization for web, mobile, CLI and gateway consumers, preserving 20-row PR execution profiles and explicit saved defaults.
- Share AC row state and judgment controls across publication, preview and evidence views in both clients, with qualified pipeline verification for every visual AC.

## 0.1.1 - 2026-10-16

- Consume the recipe-runner 0.38.1 still-filename fix throughout the worker dependency set.
