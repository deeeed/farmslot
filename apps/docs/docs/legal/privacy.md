---
title: Farmslot Privacy Policy
sidebar_label: Privacy Policy
---

# Farmslot Privacy Policy

_Last updated: May 30, 2026_

Farmslot is a developer tool for supervising local and remote agentic engineering runs from a mobile device. The Farmslot mobile app does not collect or store user data on developer-controlled servers.

## Data the app handles

Farmslot can display and send developer workflow data, including agent run status, task and prompt text, terminal output, pull request metadata, artifact links, and recipe evidence. This data is used to operate the app against the gateway URL you configure. If you enable voice input, the app uses microphone access only after you tap the voice controls to draft instructions. If you scan a pairing QR code, the app uses camera access only for that pairing flow.

## Storage on your device

The app stores gateway profiles, display preferences, filters, voice draft state, selected model settings, and update restart state on your device. Gateway secrets are stored using the platform secure storage when available. This local app storage is not sent to Farmslot developer-controlled servers.

## Network connections

The app connects to the Farmslot gateway URL you configure. Local profiles can use your LAN. Remote profiles use encrypted `wss://` connections. Data visible in the app may be sent to, received from, or processed by the configured gateway so the app can operate. If you connect to a self-hosted, local, organization-managed, or otherwise user-configured gateway, that gateway operator controls its own data handling, logging, and retention practices.

## Analytics and advertising

Farmslot does not include third-party advertising SDKs, does not use data for third-party advertising, and does not track you across apps or websites. The current mobile app does not include analytics tracking or developer-operated server-side data collection.

## Permissions

- **Microphone:** used only when you start a voice instruction flow.
- **Camera:** used only to scan a gateway pairing QR code.
- **Notifications:** used to notify you about local run, decision, and worker events when enabled.

## Contact

For privacy questions, open an issue at [github.com/deeeed/farmslot](https://github.com/deeeed/farmslot/issues) or contact the app maintainer through the App Store support channel.
