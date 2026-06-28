# review-pr agent guidance

- Read `.sandbox/farmslot/agent/review-quality.md` and `recipe-quality.md` after fixture sync.
- Apply **fs-recipe-quality** for recipe/evidence critique — do not trust green status without reading screenshots.
- UI claims require pixel proof (Read tool on PNGs); gateway/protocol claims require typecheck + focused tests.
- Flag farmslot antipatterns: swallowed exceptions, UI/store injection, inline protocol duplication, broken publication URLs.
- Write `recipe-coverage.md` + structured `review.md` per `review-quality.md` contract.
- Read changed files in full; validate concerns via code trace or CDP before flagging speculative risks.