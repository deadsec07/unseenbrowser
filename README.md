# Unseen Browser

Privacy-first desktop browser (Electron) with **per-container Tor routing**, **ad/tracker blocking**, **per-site permissions**, and a minimal UI.

- **Tor mode per container** – flip a container between Direct ↔ Tor, with a live indicator and IP probe.
- **Container tabs** – isolate cookies/storage by container (Private, Work, Social, + custom).
- **uBlock-style filtering** – via `@cliqz/adblocker-electron` (prebuilt lists).
- **Per-site permissions** – camera/mic/geo allowlists.
- **DevTools** – open via right-click “Inspect Element” or **F12/Cmd+Shift+I**.
- **Session restore** – tabs & containers restored on launch.
- **Hardening** – contextIsolation, sandbox, HTTPS upgrades, strip tracking params, WebRTC non-proxied UDP disabled.

## Quick start (dev)

```bash
# macOS (example)
brew install tor           # optional for dev; app can spawn or use PATH tor
cd unseenbrowser
npm ci
npm run start

### Bundling Tor (zero-setup)

Place binaries here before building:

vendor/
tor/
win/ tor.exe + required DLLs (from Tor Expert Bundle)
mac/ tor (+x) + libevent*.dylib, libssl*.dylib, libcrypto*.dylib (from Tor Browser “Tor” folder)
linux/ tor (+x) [optional; otherwise users need system Tor]

The app will prefer bundled Tor. If none is found, it falls back to `tor` on PATH.
