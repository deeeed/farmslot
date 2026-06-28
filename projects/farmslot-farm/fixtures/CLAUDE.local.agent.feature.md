# feature/dev agent guidance

- Read `.sandbox/farmslot-farm/agent/recipe-quality.md` before authoring `recipe.json`.
- Command Center UI: doctor pass, baseline recipe fail (or document N/A), proof run with `--record-video=full-run --task-dir`.
- Read promoted screenshots with the Read tool before claiming visual ACs pass.
- Write `evidence-manifest.json`, `recipe-coverage.md`, `recipe-quality.json`; run artifact contract check.
- Never inject UI/store state for proof — drive real recipe/CDP flows.