# Upstream

Ported from [T3 Code](https://github.com/pingdotgg/t3code) at commit `b8c2cfad`, mostly
`apps/mobile/src` and `packages/shared/src`, under the same relative paths. Copyright (c) 2026 T3
Tools Inc., MIT License (`LICENSE`).

Each file's first comment names its source and what Companion changed. The changes are limited to
imports, Companion's data sources and theme tokens, and dropping T3 features Companion does not
have (composer context, skills and models, Mermaid and math, workspace media). T3's Effect atoms,
`@pierre/diffs` and `unified`/remark are not dependencies here: their few uses are replaced inline.
