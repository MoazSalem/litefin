# Litefin Architecture & Anti-Monolith Rules

## 1. Project Context & Reality
Litefin is a high-performance Jellyfin client targeting Smart TVs ranging from ultra-legacy `AppleWebKit/538.1` (Tizen 2.3/2.4, webOS 1/2) and early Blink (`Chromium 38–53`) up to modern `Chromium 130+`, as well as Desktop and Android via Tauri.
- Source code is written in ES6+ and transpiled down to ES5 for legacy builds via Webpack and Babel.
- Target hardware includes single/dual-core ARM Cortex-A53 CPUs with 512MB–1.5GB RAM and strict GPU texture limits (~64MB–128MB).
- **The Core Problem:** Decades of feature additions without strict structural boundaries created catastrophic code monoliths that exhaust human cognitive capacity and induce AI context degradation.

---

## 2. Monolith Audit (Current Hotspots)
The following files represent extreme architectural debt and MUST be decomposed during the refactor:

| File Path | Lines | Size | Primary Violations | Target Subsystem |
| :--- | :--- | :--- | :--- | :--- |
| [`src/pages/SettingsPage.js`](src/pages/SettingsPage.js) | **13,947** | 833 KB | 14 tabs, modals, color pickers, debug loggers in one class | `src/pages/settings/` |
| [`src/pages/LibraryPage.js`](src/pages/LibraryPage.js) | **6,849** | 366 KB | Blends API queries, alpha picker, grid DOM strings, filter modals | `src/pages/library/` |
| [`src/pages/DetailsPage.js`](src/pages/DetailsPage.js) | **6,275** | 318 KB | Monolithic renderer for movies, shows, seasons, episodes, music, games | `src/pages/details/` |
| [`src/pages/PlayerPage.js`](src/pages/PlayerPage.js) | **5,026** | 271 KB | Playback lifecycle, recovery watchdogs, screen locks, dual subtitles | `src/pages/player/` |
| [`src/player/osd/OSDController.js`](src/player/osd/OSDController.js) | **5,014** | 252 KB | Controls, timeline scrub, trickplay thumbs, quick settings, menus | `src/player/osd/` |
| [`src/player/core/JellyfinPlayer.js`](src/player/core/JellyfinPlayer.js) | **4,833** | 272 KB | God-object orchestrating all backends, transcoding, subtitles | `src/player/core/` |
| [`src/api/ApiClient.js`](src/api/ApiClient.js) | **3,341** | 154 KB | Hundreds of unrelated endpoints (auth, media, live tv, syncplay, seerr) | `src/api/services/` |
| [`src/ui/LayoutManager.js`](src/ui/LayoutManager.js) | **2,197** | 106 KB | Monolithic screen density, responsive scaling, and layout mode switcher | `src/ui/layout/` |

---

## 3. Hard File Size & Single Responsibility Limits
- **Absolute Ceiling:** No newly created or refactored file may exceed **400 lines**.
- **Ideal Module Size:** **150 to 300 lines**.
- **Monolith Guard:** If a task requires modifying a monolithic file (>500 lines), you MUST NOT append logic to the monolith. Extract the target functionality into a dedicated sub-module, import it into the monolith, and verify tests pass.
- **One Conceptual Role Per File:** A file must do one thing: orchestrate lifecycle, manage API/state, handle spatial navigation, render DOM, or present a modal dialog.

---

## 4. Architectural Decomposition Patterns

### Pattern A: Standard Collection Pages (`LibraryPage`, `HomePage`, `SearchPage`)
Standard catalog pages must be decomposed into 4 distinct layers:
```
src/pages/library/
├── LibraryPage.js           # [Max 250 lines] Orchestrator: lifecycle (init, destroy), route params, wires controllers
├── LibraryDataController.js # [Max 300 lines] State, caching, Jellyfin API queries, pagination/filtering state
├── LibraryGridController.js # [Max 350 lines] Spatial navigation (row/col), scroll virtualization, focus management
├── LibraryAlphaPicker.js    # [Max 200 lines] Alphabet fast-scroll jump bar
├── LibraryModals.js         # [Max 250 lines] Filter, sort, and view-mode modal dialog orchestration
└── styles/
    └── library.css          # Scoped styles for the library view
```

### Pattern B: Multi-Tab Composite Pages (`SettingsPage`)
Composite pages with tabbed navigation must NOT embed tab implementations inside the page class.
```
src/pages/settings/
├── SettingsPage.js          # [Max 300 lines] Shell orchestrator: sidebar navigation, active tab mounting/unmounting
├── SettingsState.js         # [Max 200 lines] Shared reactive settings state & persistence synchronization
├── tabs/
│   ├── AppearanceTab.js     # [Max 350 lines] Themes, card styles, accent colors, clock format
│   ├── LayoutTab.js         # [Max 350 lines] Display scale, row density, grid sizing
│   ├── HomeTab.js           # [Max 300 lines] Home sections ordering, hero carousel settings
│   ├── SidebarTab.js        # [Max 250 lines] Sidebar links and visibility
│   ├── PlayerTab.js         # [Max 350 lines] Preferred backend, audio passthrough, max bitrates
│   ├── SubtitlesTab.js      # [Max 350 lines] Subtitle sizing, fonts, fallback culture
│   ├── PerformanceTab.js    # [Max 250 lines] Low-spec mode, animations toggle, image cache size
│   ├── ControlsTab.js       # [Max 200 lines] Remote key mappings, gamepad toggles
│   ├── AccountTab.js        # [Max 200 lines] User switch, logout, server switch
│   ├── AboutTab.js          # [Max 250 lines] App version, platform details, update checks
│   ├── BackupTab.js         # [Max 250 lines] Export/import settings, cloud sync
│   ├── DebugTab.js          # [Max 350 lines] Live log viewer, capabilities probe, memory inspector
│   ├── LibrariesTab.js      # [Max 200 lines] Library scan triggers, display preferences
│   └── PluginsTab.js        # [Max 300 lines] Installed plugins, config toggles
└── widgets/
    ├── SettingsSlider.js    # [Max 150 lines] Reusable focusable slider with live preview
    ├── SettingsDropdown.js  # [Max 200 lines] Reusable TV-friendly selection modal dropdown
    └── SettingsToggle.js    # [Max 100 lines] Accessible boolean toggle switch
```

### Pattern C: Media Details (`DetailsPage`)
Media item views must separate metadata presentation from interactive collection rows and server actions.
```
src/pages/details/
├── DetailsPage.js           # [Max 250 lines] Page lifecycle, parameter extraction, event wiring
├── DetailsDataController.js # [Max 300 lines] Fetches item, user data, seasons, episodes, cast, recommendations
├── DetailsHeroSection.js    # [Max 250 lines] Backdrop, logo, title, primary action buttons (Play, Resume, Trailer)
├── DetailsMetadataSection.js# [Max 300 lines] Overview, technical audio/video badges, rich metadata table
├── DetailsRowController.js  # [Max 350 lines] Manages Next Up, Seasons, Episodes, and Cast horizontal rows
└── DetailsActions.js        # [Max 250 lines] Item actions: Favorite, Played, Identify, Media Info, Collections
```

### Pattern D: API Client Modularization (`ApiClient`)
[`ApiClient`](src/api/ApiClient.js) must act as an aggregation facade delegating to dedicated domain services:
```
src/api/
├── ApiClient.js             # [Max 250 lines] Thin facade preserving existing public API contract
├── ApiClientCore.js         # [Max 300 lines] HTTP transport, auth token injection, retry policy, timeout handling
└── services/
    ├── AuthService.js       # [Max 250 lines] Login, logout, user enumeration, QuickConnect
    ├── ItemsService.js      # [Max 350 lines] Item retrieval, resume items, latest items, search
    ├── PlaybackService.js   # [Max 300 lines] Playback start/progress/stop reporting, stream URLs
    ├── LiveTvService.js     # [Max 250 lines] Live TV channels, EPG guide data, recordings
    ├── LibraryService.js    # [Max 200 lines] User views, library scan, folder structure
    ├── ServerService.js     # [Max 200 lines] Public info, branding, cultures, server configuration
    └── SyncPlayService.js   # [Max 300 lines] SyncPlay room management, group playback commands
```

---

## 5. Master Target Directory & Module Structure
The following structure defines the canonical destination for all refactored subsystems, enforcing the 400-line ceiling and separation of concerns while keeping CSS frozen until all logic is stabilized:

```text
src/
├── api/                           # Jellyfin & External API Transport Layer
│   ├── ApiClient.js               # Facade aggregating all domain services (<250 lines)
│   ├── ApiClientCore.js           # Fetch wrapper, auth headers, timeout/retry policies
│   ├── AuthManager.js             # Authentication lifecycle & session tokens
│   ├── WebSocketHandler.js        # Server-push events & socket recovery
│   ├── profiles/                  # Device profile capabilities
│   └── services/                  # Focused Jellyfin API domain services
│       ├── AuthService.js         # Login, logout, QuickConnect
│       ├── ItemsService.js        # Item retrieval, pagination, filters, search
│       ├── PlaybackService.js     # Playback start/progress/stop reports, stream URLs
│       ├── LiveTvService.js       # Channels, EPG data, recordings
│       ├── LibraryService.js      # User views, scan triggers, folders
│       ├── ServerService.js       # System info, branding, cultures
│       ├── SyncPlayService.js     # SyncPlay room management
│       └── SeerrService.js        # Overseerr/Jellyseerr requests & integration
│
├── core/                          # Fundamental Application Lifecycle
│   ├── App.js                     # Root orchestrator & TV boot sequence
│   ├── Router.js                  # Route navigation & history stack
│   ├── StateManager.js            # Reactive global state store
│   ├── EventBus.js                # App-wide pub/sub event bus
│   ├── Component.js               # Base component interface (.destroy(), .render())
│   ├── PlayQueue.js               # Queue state & active track management
│   ├── NavigationState.js         # Route transition history & restoration
│   └── ScreensaverManager.js      # TV idle timer & screensaver activation
│
├── navigation/                    # Spatial Navigation & Remote Control
│   ├── FocusManager.js            # Central 2D section registry & boundary routing
│   ├── SpatialNavigator.js        # Geometric vector distance calculations
│   ├── RemoteButtonManager.js     # TV D-pad, media keys, and platform keycode mapping
│   └── GamepadManager.js          # Controller joystick/button handling
│
├── ui/                            # Global UI Infrastructure & Layout
│   ├── LayoutManager.js           # Display scaling, 1080p/4K resolution density
│   ├── ScrollController.js        # Hardware-accelerated smooth scrolling & virtual tracks
│   ├── Toast.js                   # Lightweight notifications
│   └── DebugOverlay.js            # Real-time memory, FPS, and log overlay
│
├── pages/                         # Feature-Colocated Page Subsystems
│   ├── Page.js                    # Base Page class with lifecycle & section registration
│   ├── home/                      # Home screen (Page, DataController, RowController, HeroCarousel)
│   ├── library/                   # Library catalog (Page, DataController, GridController, AlphaPicker, Modals)
│   ├── details/                   # Media item details view (Page, DataController, HeroSection, Metadata, RowController, Actions)
│   ├── settings/                  # Multi-tab settings suite (Page, State, tabs/, widgets/)
│   ├── player/                    # Fullscreen playback view (Page, PlaybackSessionWatchdog)
│   └── [login|livetv|search|discover|profiles]/ # Other specialized pages
│
├── components/                    # Shared Reusable Visual Components
│   ├── layout/                    # Persistent Shell Components (Sidebar, MobileNav, GlobalClock)
│   ├── modals/                    # Standalone Dialogs & Modals (BaseModal, ExitDialog, PinDialog, MediaInfoModal, etc.)
│   └── media/                     # Shared Media Presentation Elements (CardRenderer, CardDOMPool, VirtualCardRow, FavoriteButton)
│
├── player/                        # Video & Audio Playback Engine
│   ├── core/                      # Playback Engine & Driver Adapters (JellyfinPlayer, SubtitleManager, StreamUtils, backends/)
│   └── osd/                       # On-Screen Display Overlay & Controls (OSDController, OSDTimeline, menus/)
│
├── platforms/                     # Platform-Specific Bootstrap & Bridges (tizen, webos, android, desktop, web)
├── polyfills/                     # Legacy Engine Compatibility Shims (early-polyfills, DomPolyfills, CssVarsPolyfill, AssJsPolyfills)
├── services/                      # System-Level Singletons (StorageService, Logger, PlatformInfo, ImageService, LazyLoader, LanguageManager)
└── styles/                        # [FROZEN] Strictly untouched until all JS is verified
```

---

## 6. Strict Dependency & Data Flow
1. **Unidirectional Control Flow:**
   - `Page` instantiates and orchestrates `DataController`, `GridController`, and `Renderer`.
   - `Controllers` NEVER reference other sibling controllers directly; they communicate via the `Page` or explicit callbacks.
   - `DataController` has ZERO knowledge of the DOM. It only accepts parameters and returns normalized data objects or promises.
   - `Renderer` has ZERO knowledge of the network or API client. It receives pure data and returns/mutates DOM nodes.
2. **Global Singletons Boundary:**
   - Singletons like `router`, `layoutManager`, `focusManager`, `state`, and `eventBus` must be accessed through explicit imports.
   - Never attach arbitrary shared state properties onto `window` or `document`.

---

## 7. Lifecycle & Memory Mandates
TV sessions run continuously for hours or days without page reloads on hardware with 512MB RAM.
- **Universal `.destroy()` Method:** Every controller, widget, modal, and page MUST expose a `.destroy()` method.
- **Teardown Checklist:**
  1. Unsubscribe from all `eventBus` listeners.
  2. Clear all active timers: `clearTimeout`, `clearInterval`, `cancelAnimationFrame`.
  3. Remove all DOM event listeners (`keydown`, `click`, `resize`, `scroll`).
  4. Release spatial navigation registrations from `focusManager` or `spatialNavigator`.
  5. Clear image `src` references on unmounted DOM nodes (`img.src = ''`) to allow immediate GPU texture deallocation in WebKit 538.1 and Chromium 38.
