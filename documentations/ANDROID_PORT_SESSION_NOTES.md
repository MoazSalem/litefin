# Android Port — Session Notes (landscape/touch bugfixes)

Working repo: C:\Users\bwandrych\Desktop\litefin-android, branch development.
Emulator: emulator-5554 (DPR 2.625). App install: adb -s emulator-5554 install -r dist/Litefin-<ver>.apk
Build: export ANDROID_HOME="C:/android-sdk" JAVA_HOME="C:/android-sdk/jdk21/jdk-21.0.12.1+1" && npm run build:android

## Communication bridge to the app's WebView (CDP)
- Forward: adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.litefin.app)
  (re-fetch pid after every app restart!)
- Eval: use Chrome DevTools Protocol Runtime.evaluate with awaitPromise
  (adb forward, then POST to http://127.0.0.1:9222/json to list pages). One-off
  scratch helpers (tmp-cdp/eval.cjs, hold-test.cjs) were removed after the
  v0.5.0 release; recreate on demand.

## Coordinate spaces (learned the hard way)
- adb input coordinates are DEVICE px (= CSS * 2.625).
- getBoundingClientRect under CSS zoom returns values that mix design/CSS space;
  resolve empirically with elementFromPoint before scripting taps.
- Sidebar nav is transformed -250px left: item <button> rects start at x=-250 but the
  .item-icon spans x=0..100 CSS (device x 0..262). Hit-test to find real bands.

## Verified device-space targets (SAVE THESE)
- HOME icon: device x<=105, y395..584; tap (100,489) works
- Favorites icon: hold (100,430): :active=true, label block/1 held; none/0 released
- LOGO tooltip: hold (100,100): label shows while held, hides on release

## Key architecture facts
- All landscape CSS lives in _injectLandscapeRescueCSS() in src/android/AndroidAdapter.js
  (style id 'litefin-landscape-rescue'); touch-primary gate html[data-litefin-touch] set in init()
- Sidebar tooltips (.item-text/.logo-tooltip) reveal via :focus/.focused/:hover in stock
  modern/sidebar.css; on Android overridden to: :active reveal (press-and-hold) +
  :focus-visible reveal (keyboard/remote). Sub-libraries popover labels excluded (always render).
- EPG guide (src/components/EpgGrid.js): virtualized scrollX/scrollY, GUIDE_HOURS=14 (Android),
  touch pan+fling, now-floor at _renderVirtualGrid, always-visible now line, pan re-render
  when |scrollX - data._anchorX| > 400
- Viewport-units-under-zoom trap: any fixed 100vw/100vh cover must be pinned to
  var(--litefin-app-w/h) (details backdrop, page-loading, boot splash all done)

## Versioning
- Android port versions INDEPENDENTLY of Litefin TV: releases v0.1.0..v0.5.0, all pre-release
- v0.5.0 (versionCode 5) = current: touch-first player input (tap toggles OSD,
  finger scrub shows trickplay), sidebar press-and-hold tooltips, sticky
  immersive fullscreen, forked update-check endpoint

## Release pipeline (no gh CLI; GitHub API + token via git credential fill, never print)
- create: POST /repos/bdwandry/litefin-android/releases {tag_name, body, prerelease:true}
- upload: POST {upload_url}?name=... with APK bytes
