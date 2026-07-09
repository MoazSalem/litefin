# Overview

Litefin is a high-performance, native Jellyfin client designed specifically for TV environments, currently supporting Samsung Tizen and LG webOS platforms. The project is built to deliver a premium, fluid experience that respects the limited resources of TV hardware while providing modern media features.

## 8x Build Strategy

To ensure maximum compatibility across a wide range of hardware generations—from aging legacy sets to the latest smart TVs—Litefin utilizes a targeted build pipeline. This results in 8 distinct builds (4 per platform):

1. **Modern Build**: Targets modern TVs (Tizen 6.5+, webOS 6.0+). No transpilation, utilizing pure ES6+ for maximum performance.
2. **Normal Build**: Targets mid-tier devices (Tizen 5.0+, Chromium 63). Partial transpilation for broader compatibility.
3. **Legacy Build**: Targets older hardware (Tizen 3.0+, Chromium 47). Full ES5 transpilation.
4. **Ultra Legacy Build**: Support for extremely old hardware (Tizen 2.3+, Chromium 32). Extensive polyfills, backup-logger, and style-loader instead of MiniCssExtractPlugin (file:// CORS workaround).

## Core Philosophy

Litefin focuses on:

- **Direct Performance**: Minimizing overhead between the UI and the underlying hardware APIs. No frameworks — vanilla JS with a custom component engine.
- **Visual Excellence**: Utilizing blur, glassmorphism, and smooth transitions to create a premium feel without sacrificing fluidity on low-end TV processors.
- **Native Experience**: Deep integration with platform-specific features like remote control key handling, hardware media backends (AVPlay on Tizen), and background services.
