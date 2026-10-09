<h1 align="center">Litefin</h1>
<h3 align="center">Jellyfin and Emby Client for Tizen, webOS, and Android</h3>

![Litefin Banner](./documentations/previews/banner.png)

[![GitHub license](https://img.shields.io/github/license/MoazSalem/litefin?color=orange&label=License)](https://github.com/MoazSalem/litefin/blob/release/LICENSE)
[![GitHub release (latest by date)](https://img.shields.io/github/v/release/MoazSalem/litefin?color=blue&label=Version&logo=github)](https://github.com/MoazSalem/litefin/releases)
[![GitHub all releases](https://img.shields.io/github/downloads/MoazSalem/litefin/total?label=Downloads)](https://github.com/MoazSalem/litefin/releases)
[![Discord Link](https://img.shields.io/discord/1498618592902647818?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://discord.gg/N3VpazBtTx)
[![BuyMeACoffee](https://raw.githubusercontent.com/pachadotdev/buymeacoffee-badges/main/bmc-yellow.svg)](https://www.buymeacoffee.com/moazsalem)
[![GitHub Repo stars](https://img.shields.io/github/stars/MoazSalem/litefin)](https://github.com/MoazSalem/litefin/stargazers)

Litefin is an open-source Tizen, webOS, and Android Client for Jellyfin written from scratch, designed to provide a premium experience with excellent performance for Jellyfin media browsing and playback (and Emby to a degree), even on legacy hardware. It features a robust player backend specific to each platform, advanced subtitle support, and a highly optimized UI engine for smooth browsing. On Android it runs in a thin native WebView shell with a fully touch-first UI, while TVs keep the remote-controlled experience.

Extend Litefin features by installing the **Litefin Plugin** on your [**Jellyfin**](https://github.com/MoazSalem/litefin-plugin) or [**Emby**](https://github.com/MoazSalem/litefin-plugin-emby) servers.

<img width="1920" height="1080" alt="Screenshot 2026-09-30 194946" src="https://github.com/user-attachments/assets/6ef405e1-e530-4b1e-a747-2a681576e827" />

## Features

- **Fast Native Performance**: Built in pure vanilla JavaScript with zero heavy framework overhead, custom virtualized scrolling (`VirtualCardRow`, `VirtualGrid`), and aggressive DOM recycling tailored for low-RAM TV hardware.
- **Hardware-Accelerated Triple Playback Engine**:
  - **Native Players**: Native Avplay and webOS video player integration with hardware-level buffer tuning and zero-latency seek queues.
  - **Universal Fallback**: Optimized HTML5 video player backend with auto-failover.
- **Subtitle Engine**:
  - Full SSA/ASS styling and positioning via `@jellyfin/libass-wasm` (compiled to WebAssembly) with custom font support and low-VRAM modes.
  - Native PGS image-based subtitle decoding via `libpgs`.
  - Pure JavaScript text-based subtitle parser with granular styling overrides (color, font, size, shadows, vertical positioning, offset tuning).
  - In-player subtitle search and download directly from OpenSubtitles/Jellyfin.
- **Player Controls (OSD)**:
  - Dynamic stream quality switching, audio/subtitle track selectors with persistence across episodes.
  - Chapter navigation, playback speed (0.5x–2.0x), aspect ratio overrides, and real-time playback info (bitrates, codecs, transcode reasons).
  - Synchronized scrolling lyrics for music playback, Now Playing queue management, and interactive Up Next auto-play countdowns.
  - High-performance Trickplay thumbnail previews while seeking.
- **Integrations & Plugins**:
  - **Seerr(Jellyseerr / Overseerr)**: Native discovery page, trending carousels, full search, per-season requests, and TMDB-backed "Where to Watch" streaming availability (Requires Litefin Plugin).
  - **Intro Skipper**: Automatic detection and instant skipping of TV show intros and recaps.
  - **SyncPlay**: Real-time synchronized group viewing over WebSockets.
  - **MDBList**: Multi-source community ratings (IMDb, Rotten Tomatoes, Metacritic, Trakt, TMDB, Letterboxd) directly on cards and banners.
  - **Local Intros**: Seamless playback of custom pre-roll cinema bumpers.
  - **JellyEmu**: Native retro gaming launcher and UI for emulated games.
- **TV Interface & Theming**:
  - 6+ dynamic themes (Classic Dark/Light, True Black, Tinted Light/Dark, Ambient Glow).
  - 5 customizable sidebar styles (Classic, Modern, Collapsed Modern with tooltips, Floating Buttons, Floating Island).
  - Multiple media card & row presentations (Classic rows, Modern cards, Modern posters, Expanding posters).
  - Canvas-based BlurHash placeholder decoding for buttery-smooth image loading.
- **Comprehensive Media Support**:
  - Movies, TV Series, Music, Live TV (with full EPG grid, timer scheduling, and recording playback), Photos/Slideshows, and Multi-part media (CD1/CD2) auto-chaining.
  - Jellyfin 12 ready: supports `filters2`, multi-source trickplay streams, and modern API headers.
- **TV Admin Features**: Edit item images, run metadata identification, and trigger library scans directly from the remote control.
- **Multi-Tier TV Server Discovery**: Instant connection via webOS Luna Service, Tizen HTTP service, local subnet scanning, Quick Connect QR code, and Wake-on-LAN (WoL) cold-boot support.
- **8x Targeted Build Pipeline**: 4 optimized build tiers per platform (Modern, Normal, Legacy, Ultra-Legacy) supporting everything from modern 2024+ smart TVs all the way back to Tizen 2.3+ and webOS 1.0+ (Chromium 32+).
- **Android Phones & Tablets**: The same web bundle ships inside a lightweight native WebView shell (`com.litefin.app`) with a touch-first adaptation — finger-drag media rows with fling physics, tap-to-toggle player OSD with trickplay scrubbing, adaptive portrait/landscape layouts sized for phone screens, and camera-cutout-safe edge handling. D-pad/remote navigation still works, so Android TV boxes behave like a TV.


## Documentation

Comprehensive documentation is available in the `documentations` directory:

- [**Overview**](./documentations/Overview.md): Project introduction and the 8x build strategy.
- [**Architecture**](./documentations/Architecture.md): Framework details (EventBus, FocusManager, Plugins).
- [**Plugins**](./documentations/Plugins.md): How the plugin system works and how to create them.
- [**Playback**](./documentations/Playback.md): Tizen AVPlay, web-OS adapters, and Subtitle Manager.
- [**Features**](./documentations/Features.md): Categorized list of all implemented functionality.
- [**UI & UX**](./documentations/UI_UX.md): Design system, components, and animation principles.
- [**Screenshots**](./documentations/Screenshots.md): Visual previews of the application.
- [**Development**](./documentations/Development.md): Build pipeline, variants, and deployment guide.
- [**Android**](./documentations/ANDROID.md): Android WebView shell — architecture, touch adaptation, building the APK, and platform integration points.
- [**Localization**](./documentations/Localization.md) A doc for translation contributions

## Quick Start (Development)

```bash
# Install dependencies
npm install

# Build the project
npm run build

# For Tizen Only: Add your Tizen certificates to a .sign folder or just use Apps2Samsung

# Build all packages
npm run package
```

## Building the Android APK from Source

Want to compile the Android client yourself? Here's the full recipe.

### 1. Prerequisites

- **Node.js 18+** and npm dependencies:
  ```bash
  npm install
  ```
- **JDK 21** — Gradle 8.9 rejects newer JDKs (Java 25 fails with
  `Unsupported class file major version 69`). On Windows a bundled JDK works:
  ```bash
  export JAVA_HOME="C:/android-sdk/jdk21/jdk-21.0.12.1+1"   # Git Bash / WSL style
  # PowerShell: $env:JAVA_HOME = "C:\android-sdk\jdk21\jdk-21.0.12.1+1"
  ```
- **Android SDK** with `platforms;android-35` and `build-tools;35.0.0`:
  ```bash
  export ANDROID_HOME="C:/android-sdk"   # point at your SDK root
  ```
- **Gradle 8.9** — auto-detected from `C:/android-sdk/gradle/gradle-8.9/bin`,
  `$GRADLE_HOME/bin`, or `gradle` on PATH.

### 2. One-command build (full pipeline)

```bash
npm run build:android        # → dist/Litefin-<version>.apk
```

This syncs the version, builds the modern web bundle, copies it into the
Android assets, generates launcher icons, creates a local signing keystore on
first run, runs `gradle assembleRelease`, and copies the APK to `dist/`.

> **Note:** if the Gradle step fails with an Android lint
> (`Already disposed: MessageBus` / UAST crash), it's a known toolchain issue —
> run the steps below instead, which skip lint:

### 3. Manual build (workaround path)

```bash
# 1. Compile the modern web bundle
npx gulp webpackModern

# 2. Copy it into the Android assets
rm -rf android/app/src/main/assets/webapp
cp -r dist/modern android/app/src/main/assets/webapp

# 3. Compile the APK (lint skipped)
cd android
"C:/android-sdk/gradle/gradle-8.9/bin/gradle.bat" assembleRelease \
    --no-daemon -x lint -x lintVitalRelease
cd ..

# 4. Collect the APK
cp android/app/build/outputs/apk/release/app-release.apk dist/Litefin-<version>.apk
```

### 4. Install on a device

```bash
adb install -r dist/Litefin-<version>.apk
adb shell am start -n com.litefin.app/.MainActivity
```

Remote debugging: `chrome://inspect` → the Litefin WebView.

More detail (architecture, touch adaptation, signing) lives in the
[**Android documentation**](./documentations/ANDROID.md).

## Quick Installation

### Samsung Tizen TVs

The easiest way to install on a Samsung TV is with the **Apps2Samsung** installer:

1. Download the latest `.wgt` from the [Releases](https://github.com/MoazSalem/litefin/releases) page.
2. Use [**Apps2Samsung**](https://github.com/Apps2Samsung/Apps2Samsung) to sideload the `.wgt` to your TV.
3. (Optional) Install and Configure [**Litefin Plugin**](https://github.com/MoazSalem/litefin-plugin) on your Jellyfin server.

### LG webOS TVs

Litefin can be installed on LG TVs using the **Homebrew Channel**:

1. Install the [**Homebrew Channel**](https://github.com/webosbrew/webos-homebrew-channel) on your LG TV by following the instructions in its repository.
2. Either install through the Homebrew Channel UI or download the latest `.ipk` for your hardware from the [Releases](https://github.com/MoazSalem/litefin/releases) page.
3. Open the Homebrew Channel on your TV and use the **Package Manager** to sideload the `.ipk` file.
4. (Optional) Install and Configure [**Litefin Plugin**](https://github.com/MoazSalem/litefin-plugin) on your Jellyfin server.

### Android Phones, Tablets & Android TV

Litefin ships as a standard APK:

1. Download the latest `Litefin-<version>.apk` from the [Releases](https://github.com/bdwandry/litefin-android/releases) page.
2. Sideload it onto your device (open the APK, or `adb install Litefin-<version>.apk` from a computer).
3. On Android TV boxes, install the APK the same way and use your remote — Litefin's TV navigation works out of the box.
4. (Optional) Install and Configure [**Litefin Plugin**](https://github.com/MoazSalem/litefin-plugin) on your Jellyfin server.

Building the APK yourself? See the [**Android documentation**](./documentations/ANDROID.md) for prerequisites and the build pipeline.

## Support

If Litefin is useful to you, please consider supporting the development:

- [**Buy me a coffee**](https://buymeacoffee.com/moazsalem)
- [**Sponsor this project on GitHub**](https://github.com/sponsors/MoazSalem)

<p>
  A massive thank you to the individuals supporting the development of <b>LiteFin</b>!
</p>

  <table border="0">
    <tr>
     <td align="center" width="160">
        <a href="https://github.com/Saulimedes">
          <img src="https://github.com/Saulimedes.png?s=100" width="80" alt="Paul Becker" />
          <br />
          <b>Paul Becker</b>
        </a>
      </td>
     <td align="center" width="160">
        <a href="https://github.com/massoncl">
          <img src="https://github.com/massoncl.png?s=100" width="80" alt="massoncl" />
          <br />
          <b>Clément Masson</b>
        </a>
      </td>
     <td align="center" width="160">
        <a href="https://github.com/Scoty">
          <img src="https://github.com/Scoty.png?s=100" width="80" alt="Scoty" />
          <br />
          <b>Anton Antonov</b>
        </a>
      </td>
     <td align="center" width="160">
        <a href="https://github.com/meric426">
          <img src="https://github.com/meric426.png?s=100" width="80" alt="Martin Ericson" />
          <br />
          <b>Martin Ericson</b>
        </a>
      </td>
       <td align="center" width="160">
        <a href="https://github.com/pzmarzly">
          <img  src="https://github.com/pzmarzly.png?s=100" width="80" alt="pzmarzly" />
          <br />
          <b>Paweł Zmarzły</b>
        </a>
      </td>
       </tr>
    <tr>
      <td align="center" width="160">
        <a href="https://github.com/witks">
          <img src="https://github.com/witks.png?s=100" width="80" alt="witks" />
          <br />
          <b>witek</b>
        </a>
      </td>
     <td align="center" width="160">
        <a href="https://github.com/DatAres37">
          <img src="https://github.com/DatAres37.png?s=100" width="80" alt="DatAres37" />
          <br />
          <b>DatAres37</b>
        </a>
      </td>
      <td align="center" width="160">
        <a href="https://github.com/danitesler">
          <img src="https://github.com/danitesler.png?s=100" width="80" alt="Dani Tesler" />
          <br />
          <b>Dani Tesler</b>
        </a>
      </td>
      <td align="center" width="160">
        <a href="https://github.com/h3xler">
          <img src="https://github.com/h3xler.png?s=100" width="80" alt="h3xler" />
          <br />
          <b>h3xler</b>
        </a>
      </td>
      <td align="center" width="160">
        <a href="https://github.com/d-stl">
          <img src="https://github.com/d-stl.png?s=100" width="80" alt="d-stl" />
          <br />
          <b>domantas</b>
        </a>
      </td>
     </tr>
     <tr>
       <td align="center" width="160">
        <a href="https://github.com/TheColin21">
          <img src="https://github.com/TheColin21.png?s=100" width="80" alt="TheColin21" />
          <br />
          <b>Colin P</b>
        </a>
      </td>
       <td align="center" width="160">
        <a href="https://github.com/cozyportal">
          <img src="https://github.com/cozyportal.png?s=100" width="80" alt="cozyportal" />
          <br />
          <b>cozyportal</b>
        </a>
      </td>
       <td align="center" width="160">
        <a href="https://github.com/bdwandry">
          <img src="https://github.com/bdwandry.png?s=100" width="80" alt="bdwandry" />
          <br />
          <b>bdwandry</b>
        </a>
      </td>
     </tr>
    
  </table>

## License

Litefin is subject to the terms of the **Mozilla Public License, v. 2.0**. See the [LICENSE](LICENSE) file for more details.
