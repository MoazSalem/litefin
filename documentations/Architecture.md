# Architecture

Litefin is structured as a modular Web Application. The architecture is designed to handle complex navigation, focus states, and media playback asynchronously on resource-constrained TV hardware.

## Core Framework

- **EventBus** (`src/core/EventBus.js`): A centralized pub/sub messaging system for app-wide communication, allowing decoupled modules to react to state changes (e.g., authentication, playback updates). Supports `on`, `once`, `off`, `emit`, `clear`, and `listenerCount`. Returns unsubscribe functions from `on()`/`once()`.
- **StateManager** (`src/core/StateManager.js`): Manages persistent and session-based application state, including server connections, user preferences, and reactive subscriptions. Changes emit `state:{key}` events on the EventBus for decoupled observation.
- **Router** (`src/core/Router.js`): A hash-based SPA router supporting client-side navigation, history stacks (max 20 entries), param matching (`:param` syntax), and robust state restoration via `NavigationState` when navigating between pages.
- **NavigationState** (`src/core/NavigationState.js`): Captures and restores scroll position, focus element, and page-specific state (filters, sort, pagination) during navigation. Uses a three-tier focus restoration strategy: `onRestoreIndex` hook → CSS selector (`[data-item-id]`) → section + index fallback.

## UI Engine

- **Component** (`src/core/Component.js`): Base class for all UI elements. Lifecycle: `constructor` → `render()` (returns HTML string) → `mount()` → `onMounted()` → `update()`/`setState()` → `destroy()`. Supports auto-cleaning subscriptions via `this.on()` and child tracking via `this.addChild()`.
- **Page** (`src/pages/Page.js`): Extends `Component` with route params, focus section registration, navigation state save/restore, loading/error states, and `markReady()` for async initialization.
- **FocusManager** (`src/ui/FocusManager.js`): Critical component for TV environments. Handles D-Pad navigation, section-based memory, spatial navigation, focus trapping for modals, and Magic Remote wheel support. Debounce set to 40ms for TV remote input. Uses `SpatialNavigator` and `ScrollController`.
- **VirtualCardRow** (`src/components/VirtualCardRow.js`): High-performance horizontal card row with DOM recycling (sliding window). Essential for smooth scrolling through large media libraries with limited memory.

## Platforms

The application utilizes platform detection via `PlatformInfo` (`src/utils/PlatformInfo.js`) and branching logic rather than formal adapters:

- **Tizen**: Tizen WebAPI for AVPlay hardware playback, remote control handling (`webapis`), lifecycle management, background service (server discovery).
- **webOS**: webOS-specific video player (`WebOSPlayer.js`), Luna Service calls for server discovery, file:// XHR workaround for local asset loading (fetch is blocked on webOS file://).
- **HTML5 Fallback**: `HtmlVideoPlayer.js` fallback for environments without native hardware APIs.

## Plugin System

Litefin supports modular extensions via `PluginManager` (`src/plugins/PluginManager.js`). Plugins are sandboxed through a `PluginAPI` and can listen to playback/page lifecycle events, add OSD widgets, and communicate with server-side Jellyfin plugins via `ServerPluginClient`.

**Bundled plugins:**

- **Intro Skipper** (`skip-intro`): Skip buttons for intros and recaps via server metadata.
- **SyncPlay** (`syncplay`): Real-time synchronized playback via WebSockets.
- **Local Intros** (`local-intros`): Custom intro playback from local files.
- **MDBList Ratings** (`mdblist-ratings`): Fetches and displays IMDb/Rotten Tomatoes/Metacritic/Trakt/TMDB/Letterboxd ratings on media cards and hero carousel.

[**Plugin development guide**](./Plugins.md)

## Localization

The **i18n** module (`src/utils/i18n.js`) handles multi-language support via flat JSON locale files with interpolation placeholders (`{0}`, `{1}`, …) and full Right-to-Left (RTL) layout support.

[**Localization guide**](./Localization.md)

## Screensaver & Background Services

- **ScreensaverManager** (`src/core/ScreensaverManager.js`): Dims the screen and hides titles after inactivity, ported from Jellyfin Web with TV-specific optimizations.
- Tizen background service (`services/service.js`): Runs server discovery in the background while the app is in the background, posting found servers back to the app via WebSocket.

## SyncPlay

Full SyncPlay implementation in `src/core/syncplay/` with group management (`SyncPlayGroupMenu.js`), session handling, and API support in `ApiClient` (18+ SyncPlay API methods).
