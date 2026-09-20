🚀

# Litefin - GEMINI.md

## Project Overview

Litefin is a high-performance, native Jellyfin client specifically engineered for **Samsung Tizen** (2015–present) and **LG webOS** (webOS 1.0–present) Smart TVs. Built purely in Vanilla JavaScript (ES6+) with zero heavy web frameworks, Litefin achieves near 60fps UI responsiveness and robust hardware-accelerated playback across diverse hardware generations through custom virtualized rendering, modular component lifecycle management, and a specialized multi-target compilation pipeline.

### Core Technologies

- **Vanilla JavaScript (ES6+)**: Pure JS architecture with no external UI framework overhead.
- **Webpack 5 & Gulp 5**: Multi-target compilation generating 8 distinct hardware-tailored bundles.
- **Tizen AVPlay & LG webOS Adapters**: Platform-native media pipeline integrations with hardware decoding.
- **Advanced Subtitle Engine**: WebAssembly-powered `libass` renderer (`@jellyfin/libass-wasm`), `assjs`, `libpgs` bitmap rendering, and custom subtitle styling.
- **Virtualization & GPU Scrolling**: `VirtualCardRow`, `MediaGrid`, and `ScrollController` with DOM recycling for high-density libraries.
- **Dynamic Theming**: CSS custom properties with ponyfills (`css-vars-ponyfill`) supporting custom TV skins and visual accents.

---

## 8x Build & Hardware Strategy

Litefin produces 8 distinct package bundles to maximize performance on modern chipsets while retaining backwards compatibility down to legacy TV platforms:

| Tier | Target Platforms & Versions | Engine / Transpilation Profile | Features & Optimizations |
| :--- | :--- | :--- | :--- |
| **Modern** | Tizen 6.5+ (2021+), webOS 6.0+ (2021+) | Native ES6+, no transpilation | Full WebAssembly libass, native modern web APIs |
| **Normal** | Tizen 5.0–6.0 (2019–2020), webOS 4.5–5.0 | Chromium 63+, partial transpilation | Optimized ES6 features, hardware AVPlay/webOS APIs |
| **Legacy** | Tizen 3.0–4.0 (2017–2018), webOS 3.5–4.0 | Chromium 47, full ES5 Babel transpilation | Core-JS polyfills, legacy subtitle fallback |
| **Ultra-Legacy** | Tizen 2.4 (2015–2016), webOS 1.0–3.0 | Chromium 32/38, heavy polyfills | `backup-logger`, `style-loader` (CORS fix), no-service options |
| **Debug** | Modern + Source Maps | Unminified + DevTools hooks | Runtime `DebugOverlay`, verbose logging, live metrics |

---

## Build, Run, Lint & Package Commands

### Build Commands

```bash
npm run build                 # Build all variants (Webpack multi-config)
npm run build:modern          # Build Modern variant (Tizen 6.5+ / webOS 6.0+)
npm run build:normal          # Build Normal variant (Tizen 5.0+)
npm run build:legacy          # Build Legacy variant (Tizen 3.0+)
npm run build:debug           # Build Modern debug variant with source maps
```

### Development & Dev Server

```bash
npm run dev                   # Watch mode for Normal variant
npm run serve                 # Webpack dev server (Debug variant)
npm run serve:modern          # Webpack dev server (Modern variant)
npm run serve:normal          # Webpack dev server (Normal variant)
npm run serve:legacy          # Webpack dev server (Legacy variant)
npm run serve:ultra-legacy    # Webpack dev server (Ultra-Legacy variant)
```

### Packaging (WGT & IPK)

```bash
npm run package                               # Build & package all variants (WGT + IPK)
npm run package:tizen                         # Package all Tizen variants (.wgt)
npm run package:webos                         # Package all webOS variants (.ipk)
npm run package:modern                        # Combined Modern (Tizen WGT + webOS IPK)
npm run package:normal                        # Combined Normal (Tizen WGT + webOS IPK)
npm run package:legacy                        # Combined Legacy (Tizen WGT + webOS IPK)
npm run package:ultra-legacy                  # Combined Ultra-Legacy (Tizen + webOS)
npm run package:ultra-legacy-no-service       # Ultra-Legacy without background service
npm run package:tizen-modern                  # Tizen Modern package (.wgt)
npm run package:tizen-normal                  # Tizen Normal package (.wgt)
npm run package:tizen-normal-oblong           # Tizen Normal oblong variant
npm run package:tizen-legacy                  # Tizen Legacy package (.wgt)
npm run package:tizen-ultra-legacy            # Tizen Ultra-Legacy package (.wgt)
npm run package:tizen-ultra-legacy-no-service # Tizen Ultra-Legacy without service
npm run package:tizen-test                    # Tizen Test package (Litefin-Tizen-Test.wgt)
npm run package:tizen-debug                   # Tizen Debug package (.wgt)
npm run package:webos-modern                  # webOS Modern package (.ipk)
npm run package:webos-normal                  # webOS Normal package (.ipk)
npm run package:webos-legacy                  # webOS Legacy package (.ipk)
npm run package:webos-ultra-legacy            # webOS Ultra-Legacy package (.ipk)
npm run package:webos-ultra-legacy-no-service # webOS Ultra-Legacy without service
```

### Quality & Maintenance

```bash
npm run lint                  # ESLint check (src/)
npm run lint:fix              # ESLint auto-fix
npm run format                # Prettier write (src/)
npm run format:check          # Prettier formatting check
npm run test                  # Run Node test suite (node --test tests/*.test.js)
npm run clean                 # Clean dist/, *.wgt, and *.ipk artifacts
```

### Localization

```bash
npm run locale:check          # Validate translation files against reference keys
npm run locale:sync           # Sync missing keys across locale JSONs
npm run locale:status         # Display localization completeness report
npm run locale:update         # Update localization coverage report
```

---

## Architecture & Framework

```
                    ┌──────────────────────────────────────────────┐
                    │               src/core/App.js                │
                    │  (App Controller, Router, Lifecycle, State)  │
                    └───────┬──────────────────────────────┬───────┘
                            │                              │
        ┌───────────────────┴──────────────┐      ┌────────┴────────────────────┐
        │        UI & Presentation         │      │     Media & Core Services   │
        ├──────────────────────────────────┤      ├─────────────────────────────┤
        │ • src/core/Component.js          │      │ • src/player/JellyfinPlayer │
        │ • src/pages/Page.js              │      │ • TizenAVPlayer/WebOSPlayer │
        │ • src/ui/FocusManager.js         │      │ • SubtitleManager / libass  │
        │ • src/ui/SpatialNavigator.js     │      │ • src/api/ApiClient.js      │
        │ • src/ui/ScrollController.js     │      │ • src/core/PlayQueue.js     │
        │ • src/components/Sidebar.js      │      │ • src/plugins/PluginManager │
        └──────────────────────────────────┘      └─────────────────────────────┘
```

### Core Presentation Layer

- **`Component` (`src/core/Component.js`)**: Base UI component class. Lifecycle: `constructor()` -> `render()` (returns HTML) -> `mount()` (attaches to DOM) -> `onMounted()` (DOM listeners & child mounting) -> `update()` (re-render) -> `destroy()` (cleanup).
- **`Page` (`src/pages/Page.js`)**: Base page abstraction extending `Component`. Manages route parameters, focus section registration, navigation state save/restore, and `markReady()` signalling.
- **`EventBus` (`src/core/EventBus.js`)**: Central pub/sub message hub. `on(event, fn)` returns an unsubscribe function for auto-cleanup. Also supports `emit()`, `once()`, and `off()`.
- **`Router` (`src/core/Router.js`)**: Hash-based client-side router supporting parameter matching, history stack traversal, and automatic focus/scroll state preservation via `NavigationState`.
- **`StateManager` (`src/core/StateManager.js`)**: Central observable state container (`set`, `get`, `subscribe`) broadcasting `'state:change'` events.
- **`NavigationState` (`src/core/NavigationState.js`)**: Captures active focus, scroll position, and filters before navigating and restores them upon return.
- **`FocusManager` & `SpatialNavigator` (`src/ui/`)**: Robust TV D-Pad focus engine. Computes geometric spatial transitions across grid cards, menus, and sidebars. Supports focus memory and dynamic section linking.
- **`ScrollController` (`src/ui/ScrollController.js`)**: GPU-accelerated smooth scrolling on modern platforms with step-based polyfills for legacy hardware.
- **`LayoutManager` (`src/ui/LayoutManager.js`)**: Dynamic layout controller handling sidebar collapse states, screen aspect ratios, responsive scaling, and theme switching.

### Media Playback & OSD System

- **`JellyfinPlayer` (`src/player/core/JellyfinPlayer.js`)**: Primary media playback orchestrator. Handles stream selection, transcoding negotiation, audio/subtitle track switching, prewarming, and playback reporting.
- **Platform Players**:
  - `TizenAVPlayer`: Direct Samsung AVPlay hardware bindings for optimal 4K/HDR/codec throughput.
  - `WebOSPlayer`: LG webOS media pipeline integration with Luna service compatibility.
  - `HtmlVideoPlayer`: Standard HTML5 `<video>` player fallback for desktop debugging.
- **Subtitle Subsystem (`src/player/core/`)**:
  - `LibassWasmRenderer`: WebAssembly libass renderer for accurate ASS/SSA typesetting.
  - `ASSJSRenderer`: JavaScript ASS renderer for legacy engines without WebAssembly.
  - `PGSRenderer`: WebGL/Canvas bitmap PGS subtitle renderer.
  - `SubtitleManager`: Intelligent subtitle stream selector, parser, and styling engine.
- **OSD Suite (`src/player/osd/`)**:
  - `OSDController`: Controls overlays, scrubbing timeline, track selection, and playback HUD.
  - OSD Menus: `PlaybackModeMenu`, `PlaybackSpeedMenu`, `QualityMenu`, `AspectRatioMenu`, `RepeatModeMenu`, `ResumeProfilesMenu`, `SettingsMenu`, `SubtitleOffset`, `SubtitleQuickSettings`, `TrackMenu`.
  - OSD Dialogs: `TrickplayManager`, `UpNextDialog`, `ChaptersModal`, `LyricsModal`, `QueueModal`, `DescriptionModal`, `ConfirmExitModal`, `PlayerMediaInfoModal`.

### API, Services & Plugin Subsystems

- **`ApiClient` (`src/api/ApiClient.js`)**: Complete Jellyfin API client covering item queries, user libraries, playback sessions, WebSocket sync, and transcoding profiles.
- **`AuthManager` (`src/api/AuthManager.js`)**: Manages active credentials, multi-server switching, user profiles, and quick connect.
- **`Seerr Integration` (`src/api/seerrClient.js`, `src/api/seerrNormalize.js`)**: Direct Jellyseerr / Overseerr integration for media discovery, request status tracking, and request submission modals.
- **`Plugin Architecture` (`src/plugins/`)**:
  - `PluginManager`: Lifecycle coordinator loading bundled and external plugins.
  - `PluginAPI`: Sandboxed interface exposing event hooks, persistent storage, toast notifications, and OSD widget injection.
  - `ServerPluginClient`: Communicates with Jellyfin server plugins.
  - Bundled plugins: `skip-intro` (Intro Skipper integration), `syncplay` (multi-user synchronized playback), `local-intros`, `mdblist-ratings`.
- **Core TV Utilities**:
  - `PlayQueue`: Sequential queue supporting seamless episode progression and boxsets.
  - `RemoteButtonManager`: Maps colored TV keys (Red, Green, Yellow, Blue) to custom user actions.
  - `ScreensaverManager`: Idle detection triggering configurable backdrop or logo screensavers.
  - `SmartHubManager`: Samsung SmartHub preview integration.
  - `ThemeSongPlayer`: Plays series theme audio during detail page browsing.
  - `ImageCache` & `LazyLoader`: Viewport-based lazy loading with BlurHash background decoding.

---

## Coding Standards & Conventions

### Module & File Conventions

- **ES Modules Only**: Always use `import` and `export` with explicit `.js` extensions.
- **Export Rules**:
  - Named exports for singletons: `export const logger = new Logger()`, `export const eventBus = new EventBus()`, `export const router = new Router()`, `export const state = new StateManager()`, `export const api = new ApiClient()`.
  - Default exports for UI classes: `export default class HomePage extends Page {}`.
  - Named exports for error types and utility classes: `export class ApiClient {}`.
- **Naming Conventions**:
  - `PascalCase` for classes and component files (`DetailsPage.js`, `FocusManager.js`).
  - `camelCase` for methods, functions, and properties.
  - `_prefix` for private properties and internal methods (`this._subscriptions`, `this._initFocus()`).
  - `UPPER_SNAKE_CASE` for static constants and configuration flags.
  - Colon-delimited namespaces for EventBus events (`'player:timeupdate'`, `'router:navigate'`).

### Logging

**NEVER use `console.log` in production code.** Always use the structured logger:

```javascript
import { logger } from '../utils/Logger.js';

const log = logger.create('DetailsPage');

log.info('Media loaded successfully', { itemId });
log.debug('Focus restored to row', { rowIndex: 2 });
log.warn('Fallback subtitle renderer activated');
log.error('Playback failed', error);
```

### Component Lifecycle & Memory Hygiene

To prevent memory leaks and dangling focus references on constrained TV memory:
1. Always store `EventBus` subscriptions in `this._subscriptions` and unsubscribe in `destroy()`.
2. Clean up all timers, intervals, and native DOM listeners in `destroy()`.
3. Call `destroy()` on all instantiated child components in `this._children`.
4. Ensure every interactive element has `tabindex="0"` and belongs to a registered `FocusManager` section.

### Platform Compatibility Safeguards

- **LG webOS `file://` Limitation**: Never use `fetch()` for local assets on webOS; always use `XMLHttpRequest` or the XHR helper.
- **Samsung Tizen Legacy Quirks**:
  - Never use `%c` formatting in `console.log` (causes runtime exceptions in Chromium 32).
  - Use `style-loader` instead of `MiniCssExtractPlugin` for ultra-legacy builds to avoid local `file://` CORS stylesheet restrictions.
  - Ensure early polyfills in `src/early-polyfills.js` and `src/backup-logger.js` execute before any framework imports.

---

## Critical Files Index

```
src/
├── index.js                     # Main application bootstrap & polyfill initialization
├── backup-logger.js             # Zero-dependency console logger for Tizen 2.x
├── early-polyfills.js           # Critical startup polyfills (AbortController, URLSearchParams)
├── core/
│   ├── App.js                   # Root application controller & route definitions
│   ├── Component.js             # Base UI component class
│   ├── EventBus.js              # Global pub/sub event system
│   ├── Router.js                # Hash SPA router & route dispatching
│   ├── StateManager.js          # Observable global state container
│   ├── NavigationState.js       # Focus/scroll restoration coordinator
│   ├── PlayQueue.js             # Playback queue with cross-season support
│   ├── RemoteButtonManager.js   # Color remote button mapper
│   └── ScreensaverManager.js    # Idle detection & screensaver manager
├── player/
│   ├── core/
│   │   ├── JellyfinPlayer.js    # Primary media player orchestrator
│   │   ├── TizenAVPlayer.js     # Native Samsung AVPlay engine
│   │   ├── WebOSPlayer.js       # Native LG webOS media engine
│   │   ├── HtmlVideoPlayer.js   # HTML5 video fallback engine
│   │   ├── SubtitleManager.js   # Subtitle selection & rendering coordinator
│   │   └── LibassWasmRenderer.js # WebAssembly ASS subtitle renderer
│   └── osd/
│       ├── OSDController.js     # On-Screen Display controller
│       ├── TrackMenu.js         # Audio & subtitle track selector
│       ├── QualityMenu.js       # Transcode / bitrate selector
│       └── UpNextDialog.js      # Next episode prompt dialog
├── ui/
│   ├── FocusManager.js          # TV D-Pad focus management
│   ├── SpatialNavigator.js      # Geometric 2D grid navigation
│   ├── ScrollController.js      # GPU-accelerated scroll controller
│   ├── LayoutManager.js         # Responsive layout & theme engine
│   └── Toast.js                 # TV toast notification system
├── api/
│   ├── ApiClient.js             # Jellyfin REST & WebSocket API client
│   ├── AuthManager.js           # Authentication & session store
│   ├── DeviceProfile.js         # TV playback profile generator
│   └── seerrClient.js           # Jellyseerr / Overseerr integration client
├── plugins/
│   ├── PluginManager.js         # Plugin coordinator
│   └── PluginAPI.js             # Plugin developer sandbox API
├── tizen/
│   ├── TizenAdapter.js          # Samsung Tizen platform integration
│   └── SmartHubManager.js       # Tizen SmartHub preview bar integration
└── webos/
    └── WebOSAdapter.js          # LG webOS platform integration
```

---

<!-- CODEGRAPH_START -->

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.

<!-- CODEGRAPH_END -->
