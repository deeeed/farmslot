#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
swiftc capture-helper.swift -o capture-helper \
  -framework ScreenCaptureKit -framework CoreMedia \
  -framework VideoToolbox -framework CoreGraphics \
  -framework AppKit \
  -O -target arm64-apple-macos13.0
echo "Built: $(pwd)/capture-helper"
