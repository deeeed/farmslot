# review-pr agent guidance

- Read `.sandbox/farmslot-farm/agent/review-quality.md` and `recipe-quality.md` after fixture sync.
- Apply **fs-recipe-quality** for recipe/evidence critique — do not trust green status without reading screenshots.
- UI claims require pixel proof (Read tool on PNGs); gateway/protocol claims require typecheck + focused tests.
- For cross-review closeout, diff the reviewed SHA against HEAD before assuming self-review or follow-up commits addressed findings.
- For `scripts/` fixture/compose changes, trace the CLI edge through the shell handoff: no hardcoded compose-var flattening, env values are not clobbered by absent flags, unresolved fixture path vars remain skippable, and `[OK]` is emitted only after the copy/action succeeds.
- Flag farmslot antipatterns: swallowed exceptions, UI/store injection, inline protocol duplication, broken publication URLs.
- Write `recipe-coverage.md` + structured `review.md` per `review-quality.md` contract.
- Read changed files in full; validate concerns via code trace or CDP before flagging speculative risks.
