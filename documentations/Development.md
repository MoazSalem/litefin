# Development

Litefin uses a modern web development stack optimized for generating ultra-compatible TV bundles, native Android APKs/AABs, and desktop installers.

## Build Pipeline

The project uses **Webpack** (multi-target configurations) for bundling, **Gulp** for task orchestration and Smart TV packaging, and **Tauri v2** for native Desktop and Android packaging.

### Key Build & Dev Commands

| Command                      | Description                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build`              | Build all 6 webpack variants (modern, normal, legacy, ultra-legacy, debug, normal-oblong)                                      |
| `npm run build:desktop`      | Build Webpack desktop bundle targeting the Tauri webview runtime                                                               |
| `npm run build:modern`       | Tizen 6.5+ / webOS 22+ (pure ES6+, no transpilation)                                                                           |
| `npm run build:normal`       | Tizen 5.0+ (Chromium 63, partial transpilation)                                                                                |
| `npm run build:legacy`       | Tizen 3.0+ (Chromium 47, full ES5 transpilation)                                                                               |
| `npm run build:debug`        | Modern variant + source maps for on-device debugging                                                                           |
| `npm run dev`                | Webpack watch mode (Normal variant)                                                                                            |
| `npm run serve`              | Webpack dev server (Debug variant)                                                                                             |
| `npm run serve:desktop`      | Webpack dev server targeting desktop/Tauri runtime                                                                             |
| `npm run serve:modern`       | Webpack dev server (Modern variant)                                                                                            |
| `npm run serve:normal`       | Webpack dev server (Normal variant)                                                                                            |
| `npm run serve:legacy`       | Webpack dev server (Legacy variant)                                                                                            |
| `npm run serve:ultra-legacy` | Webpack dev server (Ultra-Legacy variant)                                                                                      |
| `npm run test`               | Run Node.js built-in test runner (`node --test tests/*.test.js`)                                                               |
| `npm run clean`              | Removes `dist/`, `*.wgt`, `*.ipk`, `*.apk`, `*.exe`, `*.msi`, `*.deb`, `*.AppImage`, `*.rpm`, `*.dmg`, and `src-tauri/target/` |
| `npm run lint` / `lint:fix`  | ESLint check / auto-fix on `src/`                                                                                              |
| `npm run format` / `check`   | Prettier format / check on `src/`                                                                                              |

### Smart TV Packaging (Tizen & webOS)

| Command                                         | Output                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `npm run package`                               | All 8 TV variants (4 WGT + 4 IPK)                               |
| `npm run package:tizen`                         | All Tizen WGT packages                                          |
| `npm run package:webos`                         | All webOS IPK packages                                          |
| `npm run package:modern`                        | Combined Modern tier (Tizen WGT + webOS IPK)                    |
| `npm run package:normal`                        | Combined Normal tier (Tizen WGT + webOS IPK)                    |
| `npm run package:legacy`                        | Combined Legacy tier (Tizen WGT + webOS IPK)                    |
| `npm run package:ultra-legacy`                  | Combined Ultra-Legacy tier (Tizen WGT + webOS IPK)              |
| `npm run package:ultra-legacy-no-service`       | Combined Ultra-Legacy tier without background discovery service |
| `npm run package:tizen-modern`                  | Tizen WGT (Modern)                                              |
| `npm run package:tizen-normal`                  | Tizen WGT (Normal)                                              |
| `npm run package:tizen-normal-oblong`           | Tizen WGT (Normal oblong icon variant)                          |
| `npm run package:tizen-legacy`                  | Tizen WGT (Legacy)                                              |
| `npm run package:tizen-ultra-legacy`            | Tizen WGT (Ultra-Legacy)                                        |
| `npm run package:tizen-ultra-legacy-no-service` | Tizen WGT (Ultra-Legacy without service for Tizen 2.4)          |
| `npm run package:tizen-test`                    | Litefin-Tizen-Test.wgt (Normal variant)                         |
| `npm run package:tizen-debug`                   | Tizen WGT with debug symbols and source maps                    |
| `npm run package:webos-modern`                  | webOS IPK (Modern)                                              |
| `npm run package:webos-normal`                  | webOS IPK (Normal)                                              |
| `npm run package:webos-legacy`                  | webOS IPK (Legacy)                                              |
| `npm run package:webos-ultra-legacy`            | webOS IPK (Ultra-Legacy)                                        |
| `npm run package:webos-ultra-legacy-no-service` | webOS IPK (Ultra-Legacy without background service)             |

### Desktop Packaging (Tauri v2)

| Command                         | Output                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run package:desktop`       | Host desktop release bundle (`.exe`/`.msi` Windows, `.deb`/`.AppImage`/`.rpm` Linux, `.dmg` macOS) |
| `npm run package:desktop-debug` | Host desktop unminified debug bundle with console logging enabled                                  |
| `npm run package:windows`       | Windows release installer (`_x64-setup.exe`) and MSI package (`.msi`)                              |
| `npm run package:windows-debug` | Windows debug installer with DevTools enabled                                                      |
| `npm run package:linux`         | Linux release `.deb` package, `.rpm` package, and standalone `.AppImage`                           |
| `npm run package:linux-debug`   | Linux debug `.deb` / `.rpm` / `.AppImage` with console logs                                        |
| `npm run package:macos`         | macOS release disk image (`.dmg`)                                                                  |
| `npm run package:macos-debug`   | macOS debug disk image (`.dmg`)                                                                    |

### Android Packaging (Tauri v2 + Media3 ExoPlayer)

| Command                                   | Output                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `npm run package:android`                 | Release APKs split per ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`) |
| `npm run package:android-debug`           | Debug APKs split per ABI for local testing and logcat debugging          |
| `npm run package:android-universal`       | Single universal release APK containing all ABIs                         |
| `npm run package:android-universal-debug` | Single universal debug APK containing all ABIs                           |
| `npm run package:android-bundle`          | Android App Bundle (`.aab`) for Google Play Store distribution           |
| `npm run package:android-bundle-debug`    | Android App Bundle (`.aab`) debug build                                  |
| `npm run android:init`                    | Initialize or update Tauri Android project scaffolding                   |

### Web Client Plugin Packaging (Jellyfin Server)

| Command                               | Output                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `npm run package:plugin`              | Standard Web Client Plugin zip (`Litefin.Client.Plugin_*.zip`)           |
| `npm run package:plugin-normal`       | Normal variant plugin bundle (Chromium 63+ partial transpilation)        |
| `npm run package:plugin-legacy`       | Legacy variant plugin bundle (ES5 transpilation for older browsers)      |
| `npm run package:plugin-ultra-legacy` | Ultra-Legacy variant plugin bundle (heavy polyfills for vintage engines) |

### Tauri & Utility Commands

| Command                | Description                                                                  |
| ---------------------- | ---------------------------------------------------------------------------- |
| `npm run sync:version` | Synchronize version from `package.json` to Tizen, webOS, and Tauri manifests |
| `npm run tauri`        | Directly execute the Tauri CLI                                               |
| `npm run move:tauri`   | Move compiled Tauri output artifacts to project root                         |

### Locale Commands

| Command                 | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `npm run locale:check`  | Validate locale JSON files match `en-us.json` reference |
| `npm run locale:sync`   | Sync all locales to match `en-us.json` structure        |
| `npm run locale:status` | Show translation coverage report                        |
| `npm run locale:update` | Update `languages.js` with latest coverage percentages  |

## Platform Architecture Matrix

| Platform Tier               | Runtime Target                                 | Playback Engine                      | Input Paradigms                                           |
| :-------------------------- | :--------------------------------------------- | :----------------------------------- | :-------------------------------------------------------- |
| **Smart TV (Tizen/webOS)**  | Webpack (Modern, Normal, Legacy, Ultra-Legacy) | Tizen AVPlay / webOS Player          | TV Remote (D-Pad, Magic Remote pointer/wheel, color keys) |
| **Android (TV & Mobile)**   | Tauri v2 + Android Media3                      | ExoPlayer (`ExoVideoPlayer.js`)      | D-Pad remote, media keys, touch gestures, HW back button  |
| **Desktop (Win/Linux/Mac)** | Tauri v2 (Rust + Webview)                      | Movi Player (WASM/WebCodecs) + HTML5 | Mouse, keyboard shortcuts, window controls                |
| **Web Client Plugin**       | Jellyfin Server Plugin                         | HTML5 `<video>` Player               | Standard browser mouse, keyboard, touch                   |

## Development Guidelines

- **Modules**: Always use ES6 modules (`import`/`export`) with `.js` extension.
- **Naming**: PascalCase for classes/files, camelCase for functions/variables/methods.
- **Private members**: Underscore prefix (`this._state`, `this._load()`).
- **Strictness**: Strict equality (`===`), `const`/`let` (no `var`), and no literal throws enforced via ESLint.
- **Logging**: Use the `logger` utility at module level (`const log = logger.create('ModuleName')`); never use `console.log` in production code.
- **Async**: Use `async/await` with `try/catch` for all async operations.

## Code Conventions

- **Prettier**: Single quotes, semicolons required, 4-space indent, 120 print width, no trailing commas, always arrow parens.
- **ESLint rules**: `no-var` (error), `eqeqeq` (error, null-ignore), `no-throw-literal` (error), `no-duplicate-imports` (error), `prefer-const` (warn), `no-unused-vars` (warn, args:none).

## Deployment & Installation

### Samsung Tizen TVs

- **Certificates**: Place active Tizen certificates in `.sign/` to sign `.wgt` bundles.
- **Installation**: Sideload `.wgt` bundles using [**Apps2Samsung**](https://github.com/Apps2Samsung/Apps2Samsung) or Tizen CLI (`tizen install -n <app>.wgt -t <target>`).

### LG webOS TVs

- **Installation**: Sideload `.ipk` packages via [**webOS Homebrew Channel**](https://github.com/webosbrew/webos-homebrew-channel) or webOS CLI (`ares-install`).

### Android TV & Mobile

- **Installation**: Sideload `.apk` via **ADB** (`adb install <file>.apk`), **Downloader**, or **Send Files to TV (SFTV)**.

### Desktop

- **Installation**: Run `.exe` / `.msi` (Windows), execute `.AppImage` / install `.deb` or `.rpm` (Linux), or mount `.dmg` (macOS).

#### Keyboard Controls (Desktop & Web)

| Key / Shortcut              | Action                                             |
| :-------------------------- | :------------------------------------------------- |
| **`Space`** / **`K`**       | Play / Pause toggle                                |
| **`J`** / **`L`**           | Seek backward / forward 10 seconds                 |
| **`←`** / **`→`**           | Navigate UI items or seek timeline during playback |
| **`↑`** / **`↓`**           | Navigate UI items, menus, and OSD controls         |
| **`Enter`**                 | Select / Activate focused item or reveal OSD       |
| **`Esc`** / **`Backspace`** | Go back / Close modal / Exit player                |
| **`F`** / **`F11`**         | Toggle Fullscreen                                  |
| **`M`**                     | Mute / Unmute audio                                |
| **Media Keys**              | Hardware Play, Pause, Next, Previous, Stop         |

### Jellyfin Web Plugin

- **Installation**: Sideload repository manifest or extract `Litefin.Client.Plugin_*.zip` into the Jellyfin server `plugins/Litefin_Client` directory and restart the server.
