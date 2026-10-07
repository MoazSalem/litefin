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
| Touch row scrolling | `src/android/TouchHorizontalScroller.js` | finger-drag horizontal scrolling on media rows (below) |

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

## Touch horizontal row scrolling

On Android, media rows are **native horizontal scrollers**: `.row-items` is
switched to `overflow-x: auto`, so the browser compositor owns the drag
tracking and fling inertia — the same physics as the vertical page scroll
(no JS max-speed cap, no lag behind the finger). This mirrors the official
Jellyfin clients, which use native scrolling with programmatic focus
animation on top.

`TouchHorizontalScroller` (initialized from `AndroidAdapter.init()`) adds the
thin JS layer the TV architecture needs on top of that native scroller:

- After the browser fling ends, the row eases onto the exact card-center
  geometry `ScrollController.scrollIntoView` uses for D-pad focus, and
  `VirtualCardRow.endTouchScroll` saves the centered card index — so the
  remote continues seamlessly from wherever the finger left the row.
  The settle waits for the native momentum to genuinely stop (watching
  scrollLeft per frame) instead of firing on a fixed timer, so the JS ease
  never fights the compositor's fling velocity.
- A fresh finger press mid-fling/settle cancels the settle (catch-the-fling).
- Card clicks are suppressed for ~400ms after a real drag so the row can be
  swiped without activating a card under the finger.
- `VirtualCardRow.syncScrollToPosition` keeps the virtual card window synced
  from raw `scroll` events, and LazyLoader resumes image loading when
  scrolling goes idle.

D-pad focus centering (ScrollController) writes `scrollLeft` on Android —
touch and remote share ONE coordinate system; no `translate3d` on the track.

## Landscape text size

Inside the same landscape-only block (`@media (orientation: landscape)` +
`html[data-litefin-scaled]`), the Android shell raises the rem base to 22px
and sets `--card-title-font-scale: 1.3`, so ALL text (headers, hero
metadata, card titles/subtitles, menus, settings) renders ~37% larger in
landscape on down-scaled phone viewports. Portrait never matches the media
query and inherits the stock 16px base exactly.

## Landscape settings spacing

The same landscape-only block also opens up the Settings view vertical
rhythm (the TV-density grid reads squished on phones once text grows):
roomier setting rows (96px min-height, 28px padding, 14px gaps), larger
section-title separation, wider sidebar (430px) with phone-sized menu touch
targets (1.5rem labels, 68px rows, 31px icons), roomier option buttons, and
more generous content-panel padding. The content panel
already scrolls (`overflow-y: auto`). Portrait settings keep the exact stock
metrics (80px rows, 40px/60px padding, 350px sidebar).
Only `.row-items` rows scroll this way (hero carousel, modals and the
sidebar are excluded); the feature is compiled into the Android bundle and
gated by `platformInfo.isAndroid`, so Tizen/webOS/web are untouched.

## Landscape full-bleed backdrops

Viewport units do not scale with CSS zoom: under the display-scale zoom,
`100vw`/`100vh` resolve to the RAW phone viewport (915x412 landscape) while
the app canvas is 1600x720 design px, so any fixed element sized with them
only covered ~57% of the screen and left a black band. This hit the details
page backdrop (`.details-backdrop`) and the immersive home hero canvas
(`.hero-carousel`, whose `min-height: 420px` came from `max-height`
media queries that match the raw viewport height, not the design canvas).

Fix (landscape-scaled devices only, in `_applyDisplayScale` + the landscape
rescue block):

- `_applyDisplayScale` exposes the design-space dimensions as
  `--litefin-app-w` / `--litefin-app-h` custom properties (same values as
  the `#app` pin; removed again when zoom = 1).
- `.details-backdrop` is pinned to `var(--litefin-app-w/h)` — verified
  1600x720 (100% of the screen) in landscape.
- The immersive home hero canvas is pinned to `var(--litefin-app-h)` and
  its content re-anchored to TV proportions: title block ends ~41% down
  (padding-bottom 423px), slide dots sit in the gap below it
  (bottom: 400px), and `#home-hero-placeholder.style-immersive +
  .home-rows` overlaps at -405px so My Media starts at ~49% with cards
  floating over the full-screen artwork. Non-immersive banner modes keep
  the generic hero pairing.
- The per-page transition loading overlay (`.page-loading`, z-index 9999)
  gets the same pinning — previously it covered only the top-left ~57%,
  leaving its spinner off-center and the sidebar visible; now the screen
  goes fully black with the spinner dead-center (verified 1600x720 at 0,0,
  spinner centered at 800,360). The always-on-top clock HUD
  (`.global-clock`, z-index 100000) intentionally stays visible, matching
  TV.
- The index.html boot splash (`.splash-content`, z-index max) had the
  identical over-constrained fixed 100vw/100vh pattern — after scaling
  applied it covered ~57% of the canvas with the spinner at ~29% width.
  Same pinning applied: verified 1600x720 with the spinner at exactly
  (800,360) mid-boot (at true first paint, before JS/zoom, the raw
  viewport sizing is already correct).

Portrait never matches the media query: verified carousel 1600x824,
backdrop 412x915 (details) and app 1600x3553 are pixel-identical to the
stock layout.

## Landscape Live TV guide

The EPG guide is a fixed-height virtualized viewport sized with
`calc(100vh - 230px)` in livetv.css — under the display-scale zoom that
collapsed it to a 182px sliver (one channel row) with no way to reach the
rest. Fixes (landscape-scaled only):

- `.epg-grid-container` is sized `calc(var(--litefin-app-h) - 203px)` so it
  fits the canvas EXACTLY (verified page scrollHeight = clientHeight =
  720): five-plus channel rows visible instead of one.
- The h1 + tab header was trimmed from ~359px to ~191px (h1 2.2rem, tighter
  paddings, slimmer tab pills) — the 230px TV constant grows to 359px in
  landscape because text scales 1.375x, and the oversized header ate half
  the screen.
- The page chrome no longer rubber-bands (`overscroll-behavior: none`) and
  the grid sets `touch-action: none` so browser panning never scrolls the
  page out from under a swipe.
- EpgGrid.js (Android-gated, landscape-checked per gesture) translates
  touch swipes into the grid's own virtual scroll state — the same
  scrollX/scrollY + clamping the wheel path uses — with deltas divided by
  the zoom so a one-row finger travel pans exactly one row. Verified with
  real `adb input` swipes: two 150px-design vertical swipes scrolled
  0 -> 145.5 -> 294.9 (fractional real-touch deltas), horizontal swipes
  pan the 8-hour timeline with a 2x boost.
- The 2-hour lookback window (timeline hours before now, mostly empty
  black space on phones) is unreachable in landscape: `_renderVirtualGrid`
  enforces a now-floor (rounded to the half-hour slot, matching
  `_scrollToNow`) on Android landscape at the single point where scroll
  state becomes transforms — covering fresh opens, restored session state
  and touch panning. Verified: hard leftward swipes clamp at exactly the
  16:00 slot; TVs keep backwards browsing untouched; portrait renders
  without the floor (stock).
- The guide spans 12 hours forward from now on Android (14h track
  including the 2h lookback; TV keeps 8h), matching the reference
  Jellyfin apps. The server-side data reaches days ahead, so the whole
  span is pannable.
- Pan re-render fix in EpgGrid: rows only rendered program cells for the
  horizontal window at CREATION time — D-pad hid this (_findProgramEl
  mounts focus targets on demand) but wheel/touch panning left
  everything past the original window black forever. Rows now re-render
  their cells when panning shifts > 400px (the overscan) from their
  anchor; verified: at +8h all visible rows have program bars.
- The current-time line is always visible on Android landscape (TV only
  reveals it when D-pad focus enters the program grid; touch never
  focuses, so it would never appear).
- Fling momentum: touch panning samples gesture velocity (last ~120ms of
  applied deltas) and on finger-lift starts an exponentially decaying
  glide (~0.96/frame, ~0.4s effective tail) that reuses every clamp —
  track bounds, channel bounds, the now-floor (a boundary zeroes that
  axis instantly). A gentle lift stops dead (< 150 design px/s); a real
  flick glides ~500-1000 design px (5-10 rows). Verified with real
  swipes: vertical 314 -> 742 -> 848 -> settled 856 after finger-lift;
  horizontal fling clamps exactly at the now-floor. A new touch cancels
  the glide; destroy() cancels the rAF.
- D-pad navigation, program taps (play) and channel taps are unchanged;
  portrait keeps the stock collapsed guide untouched (verified h1 56px,
  padding 60px, grid 685px = calc(100vh - 230px), touch-action auto).

## Known limitations (intentional, minimal port)

- Portrait/landscape, touch and hardware keyboards work, but the UI remains
  the TV-optimized layout (no responsive redesign was requested).
- Jellyfin server auto-discovery uses the HTTP subnet scan fallback
  (no native UDP service); manual server entry always works.
- Trailers open as internal iframe playback (web default), not a native
  YouTube app hand-off.
- The release keystore is a local test key; replace it before any public
  distribution.
