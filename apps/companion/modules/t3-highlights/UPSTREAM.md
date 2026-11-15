# Upstream

Copied from [T3 Code](https://github.com/pingdotgg/t3code) `apps/mobile/modules/t3-highlights` at commit `b8c2cfad`.
Copyright (c) 2026 T3 Tools Inc., MIT License (see `LICENSE`).

Changes from upstream: the `tests/` harness is not copied. Keep the rest identical so later syncs stay a plain copy.

`Vendor/highlights` is [@pierre/highlights](https://www.npmjs.com/package/@pierre/highlights) 0.2.0 compiled to C with wasm2c, Apache-2.0 (`Vendor/highlights/LICENSE.md`, `NOTICE.md`). `Vendor/wasm2c` (Apache-2.0) and `Vendor/simde` (MIT) keep their own licenses.
