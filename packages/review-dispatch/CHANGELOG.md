# Changelog

## Unreleased

- Share AC row state and judgment controls across publication, preview and evidence views in both clients.

- Use gateway device-session expiry in clients instead of the temporary local sign-in lifetime.

- Document modelPickerState as the renderer API and remove the unused modelChoices method.

- Share model filtering and custom-model detection between the web and native execution pickers.

- Share compact checklist-progress presentation across operator views.

- Share client sign-in expiry and sign-out confirmation across operator apps.

- Resolve review mode once across explicit selections, recorded run/PR options and project defaults.

- Keep project review policy fields out of review selections while preserving configured defaults.
- Add shared review and dispatch selection state, capability defaults, strict validators and ordered request serialization for web, mobile, CLI and gateway consumers, preserving 20-row PR execution profiles and explicit saved defaults.

## 0.1.1 - 2026-10-16

- Consume the recipe-runner 0.38.1 still-filename fix throughout the worker dependency set.
