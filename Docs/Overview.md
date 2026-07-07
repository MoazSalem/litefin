# Overview

Litefin is a high-performance, native Jellyfin client designed specifically for TV environments, currently supporting Samsung Tizen and LG web-OS platforms. The project is built to deliver a premium, fluid experience that respects the limited resources of TV hardware while providing modern media features.

## 8x Build Strategy

To ensure maximum compatibility across a wide range of hardware generations—from aging legacy sets to the latest smart TVs—Litefin utilizes a targeted build pipeline. This results in 8 distinct builds (4 per platform):

1. **Modern Build**: Targets modern TVs (Tizen 6.5+, web-OS 6.0+). No transpilation, utilizing pure ES6+ for maximum performance.
2. **Normal Build**: The standard target for modern-mid tier devices (Tizen 5.0+, web-OS 4.0+). Transpiled for Chromium 69+.
3. **Legacy Build**: Targets older hardware (Tizen 3.0+). Transpiled for Chromium 47 (ES5).
4. **Ultra Legacy Build**: Support for extremely old hardware reaching back to Chromium 38 levels, utilizing extensive polyfills and layout fallbacks.

## Core Philosophy

Litefin focuses on:
- **Direct Performance**: Minimizing overhead between the UI and the underlying hardware APIs.
- **Visual Excellence**: Utilizing blur, glassmorphism, and smooth transitions to create a premium feel without sacrificing fluidity.
- **Native Experience**: Deep integration with platform-specific features like remote control key handling and hardware media backends (AVPlay).
