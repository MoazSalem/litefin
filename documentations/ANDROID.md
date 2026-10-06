# Litefin for Android (WebView Shell)

Litefin runs on Android phones and tablets via a thin native WebView host.
The entire UI, API layer, player OSD and plugin system come from the existing
web bundle — the same code paths as the Tizen and webOS builds.

## Architecture

```
┌──────────────────────────────────────────────┐
│  com.litefin.app (native shell)              │
│  ┌────────────────────────────────────────┐  │
│  │  WebView (system Chromium WebView)     │  │
│  │  origin: appassets.androidplatform.net │  │
│  │  window.AndroidBridge  ← JS bridge     │  │
│  └────────────────────────────────────────┘  │
│  MainActivity: back routing, splash,         │
│  lifecycle, fullscreen                       │
└──────────────────────────────────────────────┘
           │ loads
           ▼
  assets/webapp/  =  dist/modern web bundle
```

- **WebViewAssetLoader** serves the bundle from a real HTTPS origin
  (`https://appassets.androidplatform.net/assets/webapp/`), so `fetch`,
  XHR, localStorage, IndexedDB and WASM behave exactly as on the web.
- **LitefinBridge** (injected as `window.AndroidBridge`) exposes
  `notifyAppReady()`, `exitApp()`, `getDeviceModel()`, `getDeviceBrand()`,
  `getOsVersion()`.
- **Back button** flows native → JS: `onBackPressed()` calls
  `window.__litefinAndroidBack()` (registered by AndroidAdapter), which emits
  the standard `key:back` event handled by every existing modal/router/exit
  path. If the app has not booted yet, the shell backgrounds the task.
- **Platform detection**: `PlatformInfo` reports `android` when the bridge is
  present, and `LayoutManager` stamps `<html data-platform="android">`.

## Platform integration points

| Area | File | Behavior on Android |
| --- | --- | --- |
| Platform detection | `src/utils/PlatformInfo.js` | `isAndroid` / `platformString='android'` via bridge probe |
| Adapter | `src/android/AndroidAdapter.js` | back hook registration, exit, device name/model |
| App bootstrap | `src/core/App.js` | `androidAdapter.init()` alongside Tizen/webOS |
| Device identity | `src/api/AuthManager.js` | device name = `Build.MODEL` (e.g. SM-S928B) |
| Login back-exit | `src/pages/LoginPage.js` | Back on server screen exits via bridge |
| Exit dialog | `src/ui/ExitDialog.js` | confirm-exit finishes the Activity |
| Screensaver | `src/core/ScreensaverManager.js` | adapter-aware idle reporting |
| Player | `src/player/core/JellyfinPlayer.js` | auto-selects HTML5 backend (hls.js) — no changes needed |
| Device profile | `src/api/DeviceProfile.js` | falls through to `WebProfile` (MSE-capable profile) |
| Cursor CSS | `src/styles/base.css` | cursor never hidden on `data-platform="android"` |

## Build prerequisites

- Node.js 18+ and the repo's npm dependencies (`npm install`)
- JDK 17+ (Gradle 8.9 requires ≤ 21; set `JAVA_HOME` accordingly)
- Android SDK with `platforms;android-35` and `build-tools;35.0.0`
  (`ANDROID_HOME` must point at the SDK)
- Gradle 8.9 — the task auto-detects `C:/android-sdk/gradle/gradle-8.9/bin`,
  `$GRADLE_HOME/bin`, or plain `gradle` on PATH

## Building the APK

```bash
npm run build:android        # full pipeline → dist/Litefin-<version>.apk
```

The task:

1. syncs the version from `config.xml`,
2. builds the modern web bundle (webpack `modern` tier),
3. copies `dist/modern/` into `android/app/src/main/assets/webapp/`,
4. generates launcher icons from `assets/icon.png` (once, via
   `scripts/generate-android-icons.cjs`),
5. generates `android/app/release.keystore` when missing (local test key,
   password `litefin`),
6. runs `gradle assembleRelease`,
7. copies the APK to `dist/Litefin-<version>.apk`.

Rebuild web-only changes without regenerating icons:

```bash
npm run build:android-web    # bundle + icons only
npx gulp buildPackageAndroid # full APK
```

## Testing on a device

```bash
adb install -r dist/Litefin-1.9.28.apk
adb shell am start -n com.litefin.app/.MainActivity
```

Remote debugging: `chrome://inspect` → the Litefin WebView (debugging is
enabled in debug and release builds for now).

## Known limitations (intentional, minimal port)

- Portrait/landscape, touch and hardware keyboards work, but the UI remains
  the TV-optimized layout (no responsive redesign was requested).
- Jellyfin server auto-discovery uses the HTTP subnet scan fallback
  (no native UDP service); manual server entry always works.
- Trailers open as internal iframe playback (web default), not a native
  YouTube app hand-off.
- The release keystore is a local test key; replace it before any public
  distribution.
