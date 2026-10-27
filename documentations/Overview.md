# Overview

Litefin is a high-performance, open-source Jellyfin and Emby client engineered from scratch for Smart TVs (Samsung Tizen, LG webOS), Android devices (Android TV, Google TV, Fire TV, Android Mobile & Tablet), Desktop environments (Windows, Linux, macOS), and modern Web browsers (via the official Jellyfin Web client plugin).

Built purely in Vanilla JavaScript (ES6+) with zero heavy framework overhead, Litefin delivers butter-smooth 60fps UI responsiveness, hardware-accelerated playback pipelines, pixel-perfect subtitle rendering, and memory-efficient DOM recycling across hardware generations from 2015 vintage smart TVs to modern desktop and mobile powerhouses.

## Multi-Platform Distribution & Build Strategy

To ensure zero compromise between legacy hardware efficiency and modern platform capabilities, Litefin uses a targeted multi-backend build pipeline:

### 1. Smart TVs (Samsung Tizen & LG webOS)

Outputs 4 specialized tiers per platform (8 builds total) orchestrated via Webpack and Gulp:

- **Modern Build**: Targets recent high-end sets (Tizen 6.5+, webOS 22+). No transpilation, leveraging pure ES6+ and full WebAssembly.
- **Normal Build**: Targets mid-tier smart TVs (Tizen 5.0+, webOS 4.5+). Partial transpilation for broad Chromium 63+ compatibility.
- **Legacy Build**: Targets mid-lifecycle hardware (Tizen 3.0+, webOS 3.5+). Full ES5 transpilation for Chromium 47 engines.
- **Ultra-Legacy Build**: Support for vintage hardware (Tizen 2.3/2.4, webOS 1.0–3.0 / Chromium 32). Heavy polyfills, `style-loader` inline CSS (bypassing `file://` CORS restrictions), and fallback logging.

### 2. Android (Android TV, Google TV, Fire TV & Mobile)

- Native packages (`.apk` and `.aab`) powered by **Tauri v2** with **Media3 ExoPlayer**.
- Multi-architecture ABI splits (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`) and universal bundles.
- Native multichannel audio passthrough (TrueHD, DTS-HD MA, Dolby Atmos) and dynamic hardware codec discovery (`MediaCodecList`).

### 3. Desktop (Windows, Linux, macOS)

- Cross-platform desktop bundles (`.exe` / `.msi` on Windows, `.AppImage` / `.deb` / `.rpm` on Linux, `.dmg` on macOS) built with **Tauri v2**.
- High-performance WASM & WebCodecs engine (`movi-player`) alongside an optimized HTML5 video player backend with auto-failover.
- Window management, native keyboard navigation, and mouse-friendly interactions.

### 4. Web & Server Plugin (Jellyfin Web)

- Packaged as a server-side plugin (`Litefin.Client.Plugin_*.zip` or via repository manifest).
- Injects Litefin directly into your Jellyfin server web client, accessible in any modern browser at `http://<server-ip>:<port>/litefin`.

## Core Philosophy

- **Direct Performance**: Zero framework churn. Direct DOM manipulation, custom component lifecycles, and horizontal card virtualization (`VirtualCardRow`, `VirtualGrid`) to eliminate garbage collection pauses on constrained hardware.
- **Visual Excellence**: Curated dark modes, glassmorphism, smooth CSS GPU transitions, and Canvas-based BlurHash decoding for instant placeholder rendering.
- **Hardware-Native Media Engines**: Purpose-built playback backends for every runtime (Tizen AVPlay, webOS Player, Media3 ExoPlayer on Android, Movi WASM on Desktop, and HTML5 fallback).
- **Adaptive Ergonomics**: Seamless support for 10-foot TV remotes (D-Pad, Samsung Smart Remote, LG Magic Remote pointer/wheel), desktop mouse & keyboard navigation, and mobile touch gestures.
