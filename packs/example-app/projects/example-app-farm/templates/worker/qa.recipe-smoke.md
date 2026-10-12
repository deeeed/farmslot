---
id: qa/recipe-smoke
title: Example recipe smoke
flow: qa
platforms: [cli]
recipe_checks: [smoke]
recipe_actions: [example.note]
---

# Example recipe smoke

- [ ] Run `farmslot recipe run smoke` in the assigned checkout.
- [ ] Validate the returned artifact directory with `farmslot recipe artifacts <directory> --validate`.
- [ ] Confirm the note assertion and authored teardown assertion passed.
