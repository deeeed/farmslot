# Changelog

## Unreleased

- Expose the current-view copy action to the Electron UI, with `farmslot://` or `farmslot-dev://` full-view links preserving URL navigation state.

- Confirm before quitting, and fully exit after cleanup so a cancelled native quit cannot leave an invisible process blocking Dock relaunch.

- Document the shared checkout update action, local-edit protection and desktop rebuild requirements.

- Add Farmslot Dev with matching red Dock and menu-bar icons, purple production icons, separate settings and links, live frontend updates from local Vite, and bundled-UI recovery.

- Show pending decisions in the Dock badge and open `farmslot://` links to runs, gates and slots, with a native menu action to copy the current view link.

## 0.2.0 - 2026-09-20

- Run Command Center as a macOS app with the shared web UI and an unsigned local installer.
- Remember your gateway login using macOS Keychain encryption, or keep credentials only until quit by turning Remember me off.
- See pending decisions and connection status in the menu bar, configure a global show/hide shortcut, and restore the last view and window position after quit or app replacement.
