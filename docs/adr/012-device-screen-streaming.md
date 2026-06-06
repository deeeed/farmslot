# ADR-012: Device Screen Streaming — H.264 via scrcpy/ScreenCaptureKit + WebCodecs

**Status:** Accepted
**Date:** 2026-03-27
**Relates to:** [ADR-002](002-tmux-streaming.md), [ADR-008](008-remote-communication.md), [PRD](../PRD-command-center-canonical.md) — Feature C8

**Terminology note:** ADR-020 renamed the per-machine daemon from "agent" to "node". In this ADR, the streaming daemon on a machine is the Farmslot node; LLM workers remain "agents".

## Context

Terminal streaming (ADR-002) solved "watch what the agent types" — but agents also interact with visual UIs (React Native app via CDP, browser, emulator). The command center has no visibility into the device screen.

Current video capture (`xcrun simctl io recordVideo`, `adb screenrecord`) is post-hoc evidence, not live observability. `show-slot.sh` documents Xvfb/VNC/X11 forwarding as manual options — none are integrated into the command center.

The gateway already streams PTY data over WebSocket (`pty-stream.ts` multicast pattern) — device streaming mirrors this architecture.

## Options Considered

### A. Screenshot Polling

`adb exec-out screencap -p` / `xcrun simctl io screenshot` every N ms, base64 in JSON events.

**Pros:**

- Simple, no dependencies, works everywhere

**Cons:**

- Not streaming — each frame is an independent request/response
- High overhead (200-500KB PNG per frame)
- 1-5 FPS max
- Base64 bloats JSON WebSocket

### B. H.264 Streaming

scrcpy (Android) + ScreenCaptureKit Swift helper (iOS) → raw H.264 → binary WebSocket → WebCodecs decode in browser.

**Pros:**

- True streaming (persistent capture process pushes frames)
- Hardware-accelerated encode + decode
- Excellent compression (10-50KB/frame)
- Unified format across platforms
- 15-30 FPS at low bandwidth

**Cons:**

- Requires scrcpy on Android machines
- Requires building Swift helper for iOS
- WebCodecs needed in browser (Chrome 94+, Firefox 130+, Safari 17+)
- Binary WebSocket frames are new to the protocol

### C. VNC/noVNC

Android emulator VNC mode + noVNC web client.

**Pros:**

- Battle-tested, interactive, mature
- noVNC is pure JS, works in all browsers

**Cons:**

- Requires emulator started with VNC flag
- Doesn't work for iOS simulators
- Tight coupling to VNC protocol
- Poor compression vs H.264

### D. MJPEG over HTTP

Capture process outputs JPEG frames → gateway serves `multipart/x-mixed-replace` HTTP endpoint → browser `<img>` tag.

**Pros:**

- Zero browser-side codec complexity
- Works in every browser
- Simple `<img src>` rendering

**Cons:**

- Poor compression vs H.264 (3-5x larger)
- Needs ffmpeg as transcoder (scrcpy outputs H.264, not JPEG)
- Separate HTTP endpoint alongside WebSocket complicates architecture

## Decision

**Option B — H.264 streaming with WebCodecs.**

### Rationale

- Matches the "smart streaming" pattern (persistent capture, push-based, hardware-accelerated)
- scrcpy is the gold standard for Android mirroring — battle-tested, MIT licensed, 100K+ GitHub stars
- ScreenCaptureKit is Apple's recommended API for window capture (replaced deprecated CGWindowList)
- WebCodecs is stable across modern browsers (2026) and provides GPU-accelerated H.264 decode
- Binary WebSocket frames keep video data off the JSON protocol — clean separation
- Same H.264 format from both platforms → unified browser decoder
- Can add interaction (touch input relay) later without architecture change

### Architecture

```
ANDROID (remote: runner-a/runner-b)                    iOS (local: runner-local)
+----------------------------+                  +----------------------------+
| Node daemon                |                  | Gateway                    |
|  +-- scrcpy --no-display   |                  |  +-- swift capture-helper  |
|      --video-codec=h264    |                  |      (ScreenCaptureKit)    |
|      --max-size=720        |                  |      -> H.264 to stdout   |
|      -> H.264 socket       |                  +------------+---------------+
+------------+---------------+                               |
             | binary WS frames                              |
             v                                               v
    +------------------------------------------------------------+
    |                    Gateway (port 7777)                      |
    |  ScreenSessionManager: per-slot capture state              |
    |  Multicast: one capture -> N subscribers (like PtySession) |
    |  Binary WS relay: node binary -> client binary             |
    +----------------------------+-------------------------------+
                                 | binary WS frames (H.264 NAL units)
                                 v
    +------------------------------------------------------------+
    |                    Browser (UI)                             |
    |  WebCodecs VideoDecoder -> VideoFrame -> <canvas>          |
    |  Embedded in slot-view bottom panel "Device" tab           |
    +------------------------------------------------------------+
```

### Capture Specifics

**Android (scrcpy):**

- `scrcpy --no-display --video-codec=h264 --max-size=720 --max-fps=15 --serial=<ADB_SERIAL>`
- scrcpy pushes a lightweight server APK to the device, encodes framebuffer via Android MediaCodec
- Output: raw H.264 byte stream on a local TCP socket
- Node reads socket, forwards binary frames over WS to gateway
- Install: `apt install scrcpy` (Linux) or `brew install scrcpy` (macOS)

**iOS (ScreenCaptureKit helper):**

- Small Swift CLI (~100 lines) using `SCStreamConfiguration` + `SCContentFilter`
- Captures Simulator.app window by CGWindowID (resolved via `CGWindowListCopyWindowInfo`)
- Encodes to H.264 via VideoToolbox `VTCompressionSession`
- Outputs raw H.264 NAL units to stdout
- Gateway spawns as child process, reads stdout
- Build: `swiftc capture-helper.swift -o capture-helper` (single-file, no Xcode project)

### Binary WebSocket Support

Current protocol is JSON-only. Add binary frame support:

- Binary messages use a 1-byte type prefix: `0x01` = screen data
- Followed by slot ID length (1 byte) + slot ID (UTF-8) + H.264 payload
- Gateway relays binary frames only to clients subscribed to that slot's screen
- JSON protocol remains unchanged — binary is a parallel channel on the same WS connection

## Consequences

**Positive:**

- True streaming — 15-30 FPS with ~100ms latency
- Hardware-accelerated end-to-end (MediaCodec/VideoToolbox → WebCodecs)
- Low bandwidth: ~200-500 KB/s for 720p@15fps H.264 (vs 3-5 MB/s for JPEG polling)
- Unified format: both platforms output H.264, one browser decoder
- Mirrors PTY streaming pattern — multicast, subscribe/unsubscribe, cleanup on disconnect

**Negative:**

- scrcpy must be installed on Android machines (runner-a, runner-b, runner-local)
- Swift capture helper must be built and maintained (~100 lines)
- Binary WebSocket frames are new — need to update frame parsing in gateway + client
- WebCodecs not available in all browsers (fallback: screenshot polling at 1 FPS)

**Risks:**

- scrcpy server push may interfere with ADB reverse tunnels — test with existing Metro/CDP setup
- ScreenCaptureKit requires macOS screen recording permission (System Preferences → Privacy)
- H.264 NAL unit framing needs careful handling (SPS/PPS must precede IDR frames)
