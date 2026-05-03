# Unseen Browser

Unseen Browser is a privacy-first desktop browser by A A Hasnat at HNE Technologies. It is built with Electron and focuses on per-container Tor routing, tracker blocking, hardened defaults, and a minimal interface.

Links:
- Live site: https://unseenbrowser.hnetechnologies.com/
- GitHub: https://github.com/deadsec07/unseenbrowser
- Main site: https://hnetechnologies.com/
- Creator profile: https://deadsec07.github.io/

## Features

- Per-container Tor routing with live indicator and IP probe
- Container tabs for isolated cookies and storage
- Built-in ad and tracker blocking
- Per-site permissions for camera, microphone, and location
- Session restore and hardened Electron defaults

## Quick start

```bash
brew install tor
cd unseenbrowser
npm ci
npm run start
```

## Bundling Tor

Place Tor binaries under `vendor/tor/` before building for zero-setup distribution. The app prefers bundled Tor and falls back to `tor` on PATH when unavailable.
