/**
 * ============================================================================
 * Litefin Tizen - App Controller
 * ============================================================================
 * Main application controller that bootstraps the app, manages global state,
 * and coordinates between core systems (Router, State, Events).
 * ============================================================================
 */

import { eventBus } from './EventBus.js';
import { state } from './StateManager.js';
import { router } from './Router.js';
import { api } from '../api/ApiClient.js';
import { auth } from '../api/index.js';
import { webSocketHandler } from '../api/WebSocketHandler.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';
import { webosAdapter } from '../webos/WebOSAdapter.js';
// NOTE: AndroidAdapter is NOT statically imported in the boot graph - it is
// Android-only code (Media3 bridge, back-button key handling, MediaSession),
// so it is loaded on demand inside the platform dispatch below. TV tiers
// never pay its parse cost.
import { desktopAdapter } from '../desktop/DesktopAdapter.js';
import { webAdapter } from '../web/WebAdapter.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { webCodecsProbe } from '../utils/WebCodecsProbe.js';
import { layoutManager } from '../ui/LayoutManager.js';
import { isFallbackFont } from '../utils/FallbackFonts.js';
import { i18n } from '../utils/i18n.js';
import { syncPlayGroupMenu } from './syncplay/SyncPlayGroupMenu.js';
import { exitDialog } from '../ui/ExitDialog.js';
import { pinDialog } from '../ui/PinDialog.js';
import { pinManager } from '../utils/PinManager.js';
import { customHeadersDialog } from '../ui/CustomHeadersDialog.js';

// Base Page class for route proxies and page lifecycle coordination
import Page from '../pages/Page.js';

// Synchronous Page import: OfflinePage only. The browser-online probe can
// flip to false before any async chunk would have a chance to load, so the
// offline fallback must be present from boot.
//
// The other two entry pages load as async chunks {@link AsyncPageProxy}:
// HomePage's chunk import() is kicked at module evaluation time, so its
// flash-storage read and V8 parse overlap with the async boot sequence
// (splash -> sidebar -> auth restore -> server probe) instead of serializing
// ahead of them, and the 19:00-style launch reaches HomePage.init() and its
// first HTTP request without paying the home-page parse serially. LoginPage's
// chunk is fetched strictly on demand: the dominant launch path (resumed
// session restore) never pays for the login page at all.
import OfflinePage from '../pages/OfflinePage.js';

// ============================================================================
// DYNAMIC CHUNK SINGLETONS AND ASYNC MODULE LOADERS
// ============================================================================
// Cache constructors and module promises for lazy-loaded pages.
// Prevents duplicate chunk requests and guarantees synchronous instantiation
// once background prewarm resolves.

// DetailsPage chunk state
let CachedDetailsClass = null;
let detailsPrewarmPromise = null;

// LibraryPage chunk state
let CachedLibraryClass = null;
let libraryPrewarmPromise = null;

// LiveTv/Search chunk state now lives in the generic machinery below

// PlayerPage chunk state
let CachedPlayerClass = null;
let playerPrewarmPromise = null;

/**
 * Loads the DetailsPage module and its heavy dialog dependencies asynchronously.
 * Keeps large metadata tables, episode grids, and editor modals out of main.js.
 * @returns {Promise<Function>}
 */
function loadDetailsPageModule() {
    // Return cached constructor immediately if already prewarmed or loaded
    if (CachedDetailsClass) {
        return Promise.resolve(CachedDetailsClass);
    }

    // Reuse in-flight promise to avoid duplicate chunk fetch operations
    if (!detailsPrewarmPromise) {
        detailsPrewarmPromise = import(/* webpackChunkName: "details" */ '../pages/DetailsPage.js')
            .then((module) => {
                CachedDetailsClass = module.default;
                return CachedDetailsClass;
            })
            .catch((err) => {
                // Clear active promise on error to permit future retry attempts
                detailsPrewarmPromise = null;
                throw err;
            });
    }

    return detailsPrewarmPromise;
}

/**
 * Loads the LibraryPage module and virtualized grid dependencies asynchronously.
 * Defers filter dialogs, sort menus, and large card collections from main bundle.
 * @returns {Promise<Function>}
 */
function loadLibraryPageModule() {
    // Return cached constructor immediately if already prewarmed or loaded
    if (CachedLibraryClass) {
        return Promise.resolve(CachedLibraryClass);
    }

    // Reuse in-flight promise to avoid duplicate chunk fetch operations
    if (!libraryPrewarmPromise) {
        libraryPrewarmPromise = import(/* webpackChunkName: "library" */ '../pages/LibraryPage.js')
            .then((module) => {
                CachedLibraryClass = module.default;
                return CachedLibraryClass;
            })
            .catch((err) => {
                // Clear active promise on error to permit future retry attempts
                libraryPrewarmPromise = null;
                throw err;
            });
    }

    return libraryPrewarmPromise;
}

/**
 * Loads the PlayerPage and hls.js dependencies asynchronously.
 * Keeps heavy playback and subtitle demuxing engines out of initial boot V8 compilation.
 * @returns {Promise<Function>}
 */
function loadPlayerModule() {
    // Return cached constructor immediately if already prewarmed or loaded
    if (CachedPlayerClass) {
        return Promise.resolve(CachedPlayerClass);
    }

    // Reuse in-flight promise to avoid duplicate chunk fetch operations
    if (!playerPrewarmPromise) {
        playerPrewarmPromise = import(/* webpackChunkName: "player" */ '../pages/PlayerPage.js')
            .then((module) => {
                CachedPlayerClass = module.default;
                return CachedPlayerClass;
            })
            .catch((err) => {
                // Clear active promise on error to permit future retry attempts
                playerPrewarmPromise = null;
                throw err;
            });
    }

    return playerPrewarmPromise;
}

// ============================================================================
// LAZY PLAYER CHUNK PREWARMING
// ============================================================================
// The player chunk (hls.js, demuxers, subtitle pipelines) is deliberately NOT
// prewarmed right after boot: fetching it while the home page is still
// rendering steals CPU and memory from the first paint on TV hardware.
// Instead it loads when there is a real playback signal:
//   1. 600ms after the user enters a /details route (strongest predictor of
//      playback on media-first apps like this one). The grace delay lets
//      DetailsPage finish its own metadata fetch + backdrop/button render
//      first - on a 1.0GHz sticker engine, parsing 1.8MB of player JS in the
//      same tick as the route render shows up as a visible paint stall - and
//      then loads while the user is reading title/synopsis instead, and
//   2. After a long inactivity window otherwise - schedulePlayerPrewarm() is
//      re-armed by every remote/keyboard interaction (focus moves, OK,
//      back presses, route changes), so background chunk reads never compete
//      with active navigation.
// ============================================================================
const PLAYER_PREWARM_IDLE_MS = 12000;
const DETAILS_PREWARM_DELAY_MS = 600;
let playerPrewarmTimer = null;
let detailsPrewarmTimer = null;

/**
 * Arms the delayed details-entry prewarm window. Debounced per route entry;
 * if playback starts within the window, prewarmPlayerChunk() runs the
 * loading itself (a single import() promise serves both paths).
 */
function scheduleDetailsPrewarm() {
    if (playerPrewarmPromise) {
        return;
    }
    if (detailsPrewarmTimer) {
        clearTimeout(detailsPrewarmTimer);
    }
    detailsPrewarmTimer = setTimeout(() => {
        detailsPrewarmTimer = null;
        prewarmPlayerChunk('details entry');
    }, DETAILS_PREWARM_DELAY_MS);
}

/**
 * Starts (or restarts) the idle timer for background player chunk loading.
 * Re-arming on every interaction means the timer only ever fires when the
 * user has actually been idle for the full window.
 */
function schedulePlayerPrewarm() {
    if (playerPrewarmPromise) {
        return; // chunk already cached or an import() is in flight
    }
    if (playerPrewarmTimer) {
        clearTimeout(playerPrewarmTimer);
    }
    playerPrewarmTimer = setTimeout(() => {
        playerPrewarmTimer = null;
        prewarmPlayerChunk('idle');
    }, PLAYER_PREWARM_IDLE_MS);
}

/**
 * Initiates background loading of the player chunk outside of any
 * interaction context. Safe to call repeatedly - no-ops once the chunk is
 * loaded or an import() is already in flight.
 * @param {string} reason - Human-readable trigger, for the boot log
 */
function prewarmPlayerChunk(reason) {
    if (playerPrewarmPromise) {
        return;
    }
    if (playerPrewarmTimer) {
        clearTimeout(playerPrewarmTimer);
        playerPrewarmTimer = null;
    }
    if (detailsPrewarmTimer) {
        clearTimeout(detailsPrewarmTimer);
        detailsPrewarmTimer = null;
    }
    log.info(`Prewarming PlayerPage chunk in background (${reason})...`);
    loadPlayerModule()
        .then(() => log.info('PlayerPage chunk prewarmed in background'))
        .catch((err) => log.warn('PlayerPage prewarm failed:', err));
}

// ============================================================================
// DYNAMIC ROUTE PROXY CLASSES
// ============================================================================
// Declared as explicit named classes extending Page so constructor.name
// matches route identities without non-standard property reconfiguration.

/**
 * Lightweight route proxy for item details view lifecycle.
 * Intercepts router navigation, loads the async bundle, and delegates page lifecycle calls.
 */
class DetailsPage extends Page {
    constructor(options = {}) {
        super(options);
        // Active instance of RealDetailsPage once instantiated
        this._realInstance = null;
        // Lifecycle flag to cancel mounting if destroyed before chunk loading resolves
        this._isDestroyed = false;

        // Synchronously initialize instance if chunk was prewarmed in the background
        if (CachedDetailsClass) {
            this._realInstance = new CachedDetailsClass(options);
            this.el = this._realInstance.el;
            if (this._realInstance.ready) {
                this._realInstance.ready.then(() => this.markReady());
            }
        }
    }

    get el() {
        return this._realInstance ? this._realInstance.el : this._proxyEl;
    }

    set el(val) {
        this._proxyEl = val;
        if (this._realInstance) {
            this._realInstance.el = val;
        }
    }

    async init(params = {}) {
        this.params = params;
        this._initTimestamp = Date.now();
        this.container = document.getElementById('page-container') || document.getElementById('app');

        // Capture navigation state flags in case they are cleared during async chunk loading
        const isBack = router._isBackNavigation;
        const pendingState = router._pendingRestoreState;

        // Dynamically load details chunk if user navigated before background prewarm finished
        if (!this._realInstance) {
            const RealClass = await loadDetailsPageModule();
            // Abort if route changed or page was destroyed while chunk was downloading
            if (this._isDestroyed) {
                return;
            }
            this._realInstance = new RealClass(this.options);
            // Forward route pattern from proxy wrapper to real page instance
            if (this._routePattern) {
                this._realInstance._routePattern = this._routePattern;
            }
            if (this._realInstance.ready) {
                this._realInstance.ready.then(() => this.markReady());
            }
        }

        // Circuit breaker: do not proceed to initialize if destroyed mid-flight
        if (this._isDestroyed) {
            return;
        }

        // Restore back navigation flags so real instance consumes them in Page.init()
        if (isBack && !router._isBackNavigation) {
            router._isBackNavigation = true;
            router._pendingRestoreState = pendingState;
        }

        const res = await this._realInstance.init(params);

        // If destroyed while realInstance was initializing, clean it up immediately
        if (this._isDestroyed) {
            if (this._realInstance && typeof this._realInstance.destroy === 'function') {
                this._realInstance.destroy();
            }
            return res;
        }

        if (this._realInstance.title) {
            this.title = this._realInstance.title;
            document.title = `${this.title} - Litefin`;
        }
        return res;
    }

    getNavigationState() {
        if (this._realInstance && typeof this._realInstance.getNavigationState === 'function') {
            return this._realInstance.getNavigationState();
        }
        return null;
    }

    setNavigationState(state) {
        this._pendingNavState = state;
        if (this._realInstance && typeof this._realInstance.setNavigationState === 'function') {
            this._realInstance.setNavigationState(state);
        }
    }

    getScrollContainer() {
        if (this._realInstance && typeof this._realInstance.getScrollContainer === 'function') {
            return this._realInstance.getScrollContainer();
        }
        return null;
    }

    onBack() {
        if (this._realInstance && typeof this._realInstance.onBack === 'function') {
            return this._realInstance.onBack();
        }
        return false;
    }

    destroy() {
        this._isDestroyed = true;
        if (this._realInstance && typeof this._realInstance.destroy === 'function') {
            this._realInstance.destroy();
        }
        super.destroy();
    }
}

/**
 * Lightweight route proxy for library grid and browse lifecycle.
 * Intercepts router navigation, loads the async bundle, and delegates page lifecycle calls.
 */
class LibraryPage extends Page {
    constructor(options = {}) {
        super(options);
        // Active instance of RealLibraryPage once instantiated
        this._realInstance = null;
        // Lifecycle flag to cancel mounting if destroyed before chunk loading resolves
        this._isDestroyed = false;

        // Synchronously initialize instance if chunk was prewarmed in the background
        if (CachedLibraryClass) {
            this._realInstance = new CachedLibraryClass(options);
            this.el = this._realInstance.el;
            if (this._realInstance.ready) {
                this._realInstance.ready.then(() => this.markReady());
            }
        }
    }

    get el() {
        return this._realInstance ? this._realInstance.el : this._proxyEl;
    }

    set el(val) {
        this._proxyEl = val;
        if (this._realInstance) {
            this._realInstance.el = val;
        }
    }

    async init(params = {}) {
        this.params = params;
        this._initTimestamp = Date.now();
        this.container = document.getElementById('page-container') || document.getElementById('app');

        // Capture navigation state flags in case they are cleared during async chunk loading
        const isBack = router._isBackNavigation;
        const pendingState = router._pendingRestoreState;

        // Dynamically load library chunk if user navigated before background prewarm finished
        if (!this._realInstance) {
            const RealClass = await loadLibraryPageModule();
            // Abort if route changed or page was destroyed while chunk was downloading
            if (this._isDestroyed) {
                return;
            }
            this._realInstance = new RealClass(this.options);
            if (this._routePattern) {
                this._realInstance._routePattern = this._routePattern;
            }
            if (this._realInstance.ready) {
                this._realInstance.ready.then(() => this.markReady());
            }
        }

        // Circuit breaker: do not proceed to initialize if destroyed mid-flight
        if (this._isDestroyed) {
            return;
        }

        // Restore back navigation flags so real instance consumes them in Page.init()
        if (isBack && !router._isBackNavigation) {
            router._isBackNavigation = true;
            router._pendingRestoreState = pendingState;
        }

        const res = await this._realInstance.init(params);

        // If destroyed while realInstance was initializing, clean it up immediately
        if (this._isDestroyed) {
            if (this._realInstance && typeof this._realInstance.destroy === 'function') {
                this._realInstance.destroy();
            }
            return res;
        }

        if (this._realInstance.title) {
            this.title = this._realInstance.title;
            document.title = `${this.title} - Litefin`;
        }
        return res;
    }

    getNavigationState() {
        if (this._realInstance && typeof this._realInstance.getNavigationState === 'function') {
            return this._realInstance.getNavigationState();
        }
        return null;
    }

    setNavigationState(state) {
        this._pendingNavState = state;
        if (this._realInstance && typeof this._realInstance.setNavigationState === 'function') {
            this._realInstance.setNavigationState(state);
        }
    }

    getScrollContainer() {
        if (this._realInstance && typeof this._realInstance.getScrollContainer === 'function') {
            return this._realInstance.getScrollContainer();
        }
        return null;
    }

    onBack() {
        if (this._realInstance && typeof this._realInstance.onBack === 'function') {
            return this._realInstance.onBack();
        }
        return false;
    }

    destroy() {
        this._isDestroyed = true;
        if (this._realInstance && typeof this._realInstance.destroy === 'function') {
            this._realInstance.destroy();
        }
        super.destroy();
    }
}

/**
 * Lightweight route proxy for video player lifecycle.
 * Intercepts router navigation, loads the async bundle, and delegates page lifecycle calls.
 * Declared directly as PlayerPage so constructor.name is naturally 'PlayerPage' without Object.defineProperty.
 */
class PlayerPage extends Page {
    constructor(options = {}) {
        super(options);
        // Active instance of RealPlayerPage once instantiated
        this._realInstance = null;
        this.el = null;
        // Lifecycle flag to cancel mounting if destroyed before chunk loading resolves
        this._isDestroyed = false;

        // Synchronously initialize instance if chunk was prewarmed in the background
        if (CachedPlayerClass) {
            this._realInstance = new CachedPlayerClass(options);
            this.el = this._realInstance.el;
            if (this._realInstance.ready) {
                this._realInstance.ready.then(() => this.markReady());
            }
        }
    }

    get osd() {
        return this._realInstance ? this._realInstance.osd || this._realInstance._osd : null;
    }

    get _osd() {
        return this._realInstance ? this._realInstance._osd || this._realInstance.osd : null;
    }

    async init(params) {
        // Dynamically load player chunk if user launched playback before background prewarm finished
        if (!this._realInstance) {
            const PlayerClass = await loadPlayerModule();
            // Abort if route changed or playback was canceled while chunk was downloading
            if (this._isDestroyed) {
                return;
            }
            this._realInstance = new PlayerClass(this.options);
            this.el = this._realInstance.el;
            if (this._routePattern) {
                this._realInstance._routePattern = this._routePattern;
            }
            if (this._realInstance.ready) {
                this._realInstance.ready.then(() => this.markReady());
            }
        }

        // Circuit breaker: do not proceed to initialize if destroyed mid-flight
        if (this._isDestroyed) {
            return;
        }

        const res = await this._realInstance.init(params);

        // If destroyed while realInstance was initializing, clean it up immediately
        if (this._isDestroyed) {
            if (this._realInstance && typeof this._realInstance.destroy === 'function') {
                this._realInstance.destroy();
            }
            return res;
        }

        return res;
    }

    destroy() {
        this._isDestroyed = true;
        if (this._realInstance && typeof this._realInstance.destroy === 'function') {
            this._realInstance.destroy();
        }
        super.destroy();
    }

    onBack() {
        if (this._realInstance && typeof this._realInstance.onBack === 'function') {
            return this._realInstance.onBack();
        }
        return false;
    }

    showResumeProfileSelector() {
        if (this._realInstance && typeof this._realInstance.showResumeProfileSelector === 'function') {
            return this._realInstance.showResumeProfileSelector();
        }
    }
}

// ============================================================================
// GENERIC ASYNC PAGE CHUNK MACHINERY (Settings, Person, Seerr, Discover, ...)
// ============================================================================
// Same proxy/prewarm pattern as the four explicit proxies above, factored into
// a shared loader factory and one base proxy class to avoid duplicating ~800
// lines of delegation boilerplate nine times. Each page keeps an explicit
// named subclass so route registration identities stay human-readable and
// constructor.name keeps matching the registered route.

/**
 * Creates singleton chunk state { cached, load } for an async page module.
 * Guarantees a single in-flight chunk fetch across concurrent navigations and
 * background prewarms; clears the active promise on error so a later route hit
 * can retry the import.
 * @param {Function} importer - Zero-arg dynamic import thunk for the page module
 * @returns {{cached: Function|null, load: () => Promise<Function>}}
 */
function createPageChunkLoader(importer) {
    const chunk = { cached: null, promise: null };

    chunk.load = () => {
        // Return cached constructor immediately if already prewarmed or loaded
        if (chunk.cached) {
            return Promise.resolve(chunk.cached);
        }

        // Reuse in-flight promise to avoid duplicate chunk fetch operations
        if (!chunk.promise) {
            chunk.promise = importer()
                .then((module) => {
                    chunk.cached = module.default;
                    // Chunks carry their own <style> tags (style-loader tiers);
                    // on legacy engines the CSS-var polyfill must adopt any
                    // freshly injected stylesheet before the page renders.
                    cssVarsPolyfill.ensureStylesResolved();
                    return chunk.cached;
                })
                .catch((err) => {
                    // Clear active promise on error to permit future retry attempts
                    chunk.promise = null;
                    throw err;
                });
        }

        return chunk.promise;
    };

    return chunk;
}

// One chunk state per page module. The two JellySeerr pages share ONE chunk
// file (identical webpackChunkName): both import each other's seerr API
// client layer, so emitting a single chunk keeps that module from being
// duplicated into two separate script files under the splitChunks-off
// legacy configuration.
const settingsChunk = createPageChunkLoader(
    () => import(/* webpackChunkName: "settings" */ '../pages/settings/SettingsPage.js')
);
const personChunk = createPageChunkLoader(() => import(/* webpackChunkName: "person" */ '../pages/PersonPage.js'));
const seerrDetailsChunk = createPageChunkLoader(
    () => import(/* webpackChunkName: "seerr" */ '../pages/SeerrDetailsPage.js')
);
const seerrPersonChunk = createPageChunkLoader(
    () => import(/* webpackChunkName: "seerr" */ '../pages/SeerrPersonPage.js')
);
const discoverChunk = createPageChunkLoader(
    () => import(/* webpackChunkName: "discover" */ '../pages/DiscoverPage.js')
);
const favoritesChunk = createPageChunkLoader(
    () => import(/* webpackChunkName: "favorites" */ '../pages/FavoritesPage.js')
);
const profilesChunk = createPageChunkLoader(
    () => import(/* webpackChunkName: "profiles" */ '../pages/ProfilesPage.js')
);
const slideshowChunk = createPageChunkLoader(
    () => import(/* webpackChunkName: "slideshow" */ '../pages/SlideshowPage.js')
);
const emulatorChunk = createPageChunkLoader(
    () => import(/* webpackChunkName: "emulator" */ '../pages/EmulatorPage.js')
);
const searchChunk = createPageChunkLoader(() => import(/* webpackChunkName: "search" */ '../pages/SearchPage.js'));
const liveTvChunk = createPageChunkLoader(() => import(/* webpackChunkName: "livetv" */ '../pages/LiveTvPage.js'));
const homeChunk = createPageChunkLoader(() => import(/* webpackChunkName: "home" */ '../pages/HomePage.js'));
const loginChunk = createPageChunkLoader(() => import(/* webpackChunkName: "login" */ '../pages/LoginPage.js'));

/**
 * Shared route proxy base for async page chunks. Intercepts router navigation,
 * loads the async bundle on demand, and delegates page lifecycle calls to the
 * real instance. The constructor receives the singleton chunk state so the
 * named subclasses below can bind their loader while constructor.name keeps
 * matching their registered route identities.
 */
class AsyncPageProxy extends Page {
    constructor(options = {}, chunk = null) {
        super(options);
        // Active instance of the real page once instantiated
        this._realInstance = null;
        this._proxyEl = null;
        this._chunk = chunk;
        // Lifecycle flag to cancel mounting if destroyed before chunk loading resolves
        this._isDestroyed = false;

        // Synchronously initialize instance if chunk was prewarmed in the background
        if (chunk && chunk.cached) {
            this._realInstance = new chunk.cached(options);
            this._proxyEl = this._realInstance.el;
            if (this._realInstance.ready) {
                this._realInstance.ready.then(() => this.markReady());
            }
        }
    }

    get el() {
        return this._realInstance ? this._realInstance.el : this._proxyEl;
    }

    set el(val) {
        this._proxyEl = val;
        if (this._realInstance) {
            this._realInstance.el = val;
        }
    }

    async init(params = {}) {
        this.params = params;
        this._initTimestamp = Date.now();
        this.container = document.getElementById('page-container') || document.getElementById('app');

        // Capture navigation state flags in case they are cleared during async chunk loading
        const isBack = router._isBackNavigation;
        const pendingState = router._pendingRestoreState;

        // Dynamically load the page chunk if user navigated before background prewarm finished
        if (!this._realInstance && this._chunk) {
            const RealClass = await this._chunk.load();
            // Abort if route changed or page was destroyed while chunk was downloading
            if (this._isDestroyed) {
                return;
            }
            this._realInstance = new RealClass(this.options);
            this._proxyEl = this._realInstance.el;
            if (this._routePattern) {
                this._realInstance._routePattern = this._routePattern;
            }
            if (this._realInstance.ready) {
                this._realInstance.ready.then(() => this.markReady());
            }
        }

        // Circuit breaker: do not proceed to initialize if destroyed mid-flight
        if (this._isDestroyed) {
            return;
        }

        // Restore back navigation flags so real instance consumes them in Page.init()
        if (isBack && !router._isBackNavigation) {
            router._isBackNavigation = true;
            router._pendingRestoreState = pendingState;
        }

        const res = await this._realInstance.init(params);

        // If destroyed while realInstance was initializing, clean it up immediately
        if (this._isDestroyed) {
            if (this._realInstance && typeof this._realInstance.destroy === 'function') {
                this._realInstance.destroy();
            }
            return res;
        }

        if (this._realInstance && this._realInstance.title) {
            this.title = this._realInstance.title;
            document.title = `${this.title} - Litefin`;
        }
        return res;
    }

    getNavigationState() {
        if (this._realInstance && typeof this._realInstance.getNavigationState === 'function') {
            return this._realInstance.getNavigationState();
        }
        return null;
    }

    setNavigationState(state) {
        this._pendingNavState = state;
        if (this._realInstance && typeof this._realInstance.setNavigationState === 'function') {
            this._realInstance.setNavigationState(state);
        }
    }

    getScrollContainer() {
        if (this._realInstance && typeof this._realInstance.getScrollContainer === 'function') {
            return this._realInstance.getScrollContainer();
        }
        return null;
    }

    onBack() {
        if (this._realInstance && typeof this._realInstance.onBack === 'function') {
            return this._realInstance.onBack();
        }
        return false;
    }

    destroy() {
        this._isDestroyed = true;
        if (this._realInstance && typeof this._realInstance.destroy === 'function') {
            this._realInstance.destroy();
        }
        super.destroy();
    }
}

/**
 * Route proxy for the full settings console (870KB source, by far the largest
 * page module in the client). Settings is rarely the first navigation target,
 * so deferring it keeps ~230KB of minified JS out of the startup parse.
 */
class SettingsPage extends AsyncPageProxy {
    constructor(options) {
        super(options, settingsChunk);
    }
}

/**
 * Route proxy for the home view. The chunk import is kicked at module
 * evaluation time (see {prewarmHomeChunk}) so the disk read + parse overlap
 * with the async boot window; by the time router.navigate('/home') runs the
 * real HomePage instance is usually created synchronously from cache.
 */
class HomePage extends AsyncPageProxy {
    constructor(options) {
        super(options, homeChunk);
    }
}

/**
 * Route proxy for the login view. Loaded strictly on demand so the dominant
 * authenticated launch path never reads/parses the login module at all.
 */
class LoginPage extends AsyncPageProxy {
    constructor(options) {
        super(options, loginChunk);
    }
}

/**
 * Route proxy for person credits / filmography views.
 */
class PersonPage extends AsyncPageProxy {
    constructor(options) {
        super(options, personChunk);
    }
}

/**
 * Route proxy for JellySeerr item detail view (request/search results).
 */
class SeerrDetailsPage extends AsyncPageProxy {
    constructor(options) {
        super(options, seerrDetailsChunk);
    }
}

/**
 * Route proxy for JellySeerr person cast credits (shares the seerr chunk).
 */
class SeerrPersonPage extends AsyncPageProxy {
    constructor(options) {
        super(options, seerrPersonChunk);
    }
}

/**
 * Route proxy for the discover / curated collections view.
 */
class DiscoverPage extends AsyncPageProxy {
    constructor(options) {
        super(options, discoverChunk);
    }
}

/**
 * Route proxy for the user favorites view.
 */
class FavoritesPage extends AsyncPageProxy {
    constructor(options) {
        super(options, favoritesChunk);
    }
}

/**
 * Route proxy for the "Who's Watching" profile switcher view.
 */
class ProfilesPage extends AsyncPageProxy {
    constructor(options) {
        super(options, profilesChunk);
    }
}

/**
 * Route proxy for the photo slideshow viewer.
 */
class SlideshowPage extends AsyncPageProxy {
    constructor(options) {
        super(options, slideshowChunk);
    }
}

/**
 * Route proxy for the JellyEmu game player view.
 */
class EmulatorPage extends AsyncPageProxy {
    constructor(options) {
        super(options, emulatorChunk);
    }
}

/**
 * Route proxy for the global search view. Formerly part of the synchronous
 * boot path; search is only reachable after login once content browsing
 * works, so the chunk fetch costs nothing at cold boot.
 */
class SearchPage extends AsyncPageProxy {
    constructor(options) {
        super(options, searchChunk);
    }
}

/**
 * Route proxy for the Live TV guide / EPG timetable view. Loaded strictly on
 * demand - previously stage-1 prewarmed, it is the rarest navigation target
 * among primary views on non-broadcast setups.
 */
class LiveTvPage extends AsyncPageProxy {
    constructor(options) {
        super(options, liveTvChunk);
    }
}
import Sidebar from '../components/Sidebar.js';
import MobileNav from '../components/MobileNav.js';

import { logger } from '../utils/Logger.js';
import { storage } from '../utils/StorageService.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { debugOverlay } from '../ui/DebugOverlay.js';
import { pluginManager } from '../plugins/PluginManager.js';
import { focusManager } from '../ui/FocusManager.js';
import { imageCache } from '../utils/ImageCache.js';
import { cssVarsPolyfill } from '../utils/CssVarsPolyfill.js';
import { versionChecker } from '../utils/VersionChecker.js';
import { timeManager } from '../utils/TimeManager.js';
import { globalClock } from '../ui/GlobalClock.js';
import { smartHubManager } from '../tizen/SmartHubManager.js';
import { androidLauncherManager } from '../android/AndroidLauncherManager.js';
import { remoteButtonManager } from './RemoteButtonManager.js';
import { screensaverManager } from './ScreensaverManager.js';

const log = logger.create('App');

// ============================================================================
// HOME CHUNK EARLY KICKOFF
// ============================================================================
// Fire the HomePage chunk import() during boot-bundle module evaluation - the
// earliest moment App code can run. The flash read + V8 parse of home.js then
// overlap every async step below (splash, sidebar mount, auth restore, server
// probe) instead of serializing ahead of them: when router.navigate('/home')
// eventually fires, the AsyncPageProxy usually instantiates the real HomePage
// synchronously from the already-loaded chunk. Has no effect on the login
// path beyond one background file read; LoginPage itself stays fetch-on-demand.
homeChunk.load().then(
    () => log.info('HomePage chunk ready (early boot prewarm)'),
    (err) => log.warn('HomePage chunk prewarm failed:', err)
);

class App {
    constructor() {
        // App initialization state
        this._initialized = false;

        // Reference to main content container
        this.container = null;
    }

    /**
     * Initialize the application
     * @param {Object} options - Initialization options
     * @param {HTMLElement|string} options.container - Main content container
     */
    async init(options = {}) {
        if (this._initialized) {
            log.warn('App already initialized');
            return;
        }

        // 1. Initialize StorageService — loads all localStorage into memory
        // This MUST happen before any other service reads from storage
        storage.init();

        // 1.1 Clear session-scoped memory
        // Ensures track memory doesn't leak across app restarts
        storage.removeItem('session:lastAudioLang');
        storage.removeItem('session:lastAudioTitle');
        storage.removeItem('session:lastSubtitleLang');
        storage.removeItem('session:lastSubtitleTitle');

        // 1.5. Initialize Platform Detection — saves OS type (Web, Tizen, WebOS)
        platformInfo.init();

        // 1.6. Initialize platform adapters (hardware/keys/lifecycle)
        // Dispatches to the strictly targeted adapter based on runtime environment:
        // - Samsung Tizen Smart TVs -> TizenAdapter
        // - LG WebOS Smart TVs -> WebOSAdapter
        // - Android TV / Google TV / Android -> AndroidAdapter
        // - Packaged Desktop App Shells (Tauri) -> DesktopAdapter
        // - Standard Web Browsers -> WebAdapter
        if (platformInfo.isTizen) {
            tizenAdapter.init();
        } else if (platformInfo.isWebOS) {
            webosAdapter.init();
        } else if (platformInfo.isAndroid) {
            // Android adapter is loaded on demand here - see the module note
            // at the top of this file.
            import('../android/AndroidAdapter.js')
                .then(({ androidAdapter }) => androidAdapter.init())
                .catch((err) => log.warn('AndroidAdapter init failed:', err));
        } else if (platformInfo.isDesktop) {
            desktopAdapter.init();
        } else {
            webAdapter.init();
        }

        // 1.6.1. Probe WebCodecs AV1 decoding in the background (Movi backend on desktop and web)
        if ((platformInfo.isDesktop || platformInfo.isWeb) && platformInfo.hasWebCodecsSupport) {
            webCodecsProbe.probeAV1();
        }

        // 1.7. Initialize Image Cache — opens IndexedDB for homepage blob caching
        // Non-blocking: runs in background, cache degrades gracefully if unavailable
        imageCache.init().catch((err) => log.warn('ImageCache init failed:', err));

        // 2. Initialize Debug Overlay (loads state from StorageService cache)
        const DEBUG_LOGS = storage.getItem('debug_logs_enabled') === 'true';
        const DEBUG_OVERLAY = storage.getItem('debug_overlay_enabled') === 'true';
        const DEBUG_WIDTH = storage.getItem('debug_width') || 'small';
        const DEBUG_HEIGHT = storage.getItem('debug_height') || 'small';
        const DEBUG_POSITION = storage.getItem('debug_position') || 'bottom-right';

        debugOverlay.init(DEBUG_LOGS, DEBUG_OVERLAY, DEBUG_WIDTH, DEBUG_HEIGHT, DEBUG_POSITION);

        // Calculate early-boot telemetry
        // Measures time from HTML <head> parse and browser navigationStart
        const now = Date.now();
        const htmlToApp = now - (window.__htmlStart || now);
        const navStart =
            window.performance && window.performance.timing ? window.performance.timing.navigationStart : null;
        const osToApp = navStart ? now - navStart : null;
        log.info(
            `Initializing Litefin... [Boot Telemetry: HTML-to-App=${htmlToApp}ms, WAM-to-App=${osToApp !== null ? osToApp + 'ms' : 'N/A'}]`
        );

        // 3. Initialize layout manager
        layoutManager.init();

        // 3.0. Initialize OSD track menu bg opacity CSS variable
        const trackMenuBgOpacity = PlayerSettings.get('osdTrackMenuBgOpacity');
        document.documentElement.style.setProperty(
            '--osd-track-menu-bg-opacity',
            (trackMenuBgOpacity / 100).toFixed(2)
        );

        // Initialize OSD background gradient opacity CSS variable
        const osdGradientOpacity = PlayerSettings.get('osdGradientOpacity');
        document.documentElement.style.setProperty('--osd-gradient-opacity', (osdGradientOpacity / 100).toFixed(2));

        // 3.1. Initialize CSS vars polyfill (no-op on Chrome 49+, active on Tizen 3.0 / Chrome 47).
        //      Must run AFTER layoutManager.init() so the data-theme attribute and theme
        //      CSS variables are already present on <html> when the polyfill scans the DOM.
        cssVarsPolyfill.init();

        // 3.5. Initialize translations + auth session in parallel
        // i18n and auth are completely independent — overlapping them saves a round-trip
        const appLanguage = storage.getItem('app_language') || 'en-us';
        const i18nPromise = i18n.init(appLanguage);
        const authPromise = auth.init();

        // 3.6. Initialize Layout Direction (RTL/LTR) — only needs appLanguage string, not i18n data
        const layoutDirection = storage.getItem('layout_direction') || 'auto';
        let isRtl = false;

        if (layoutDirection === 'auto') {
            const rtlLangs = ['ar', 'he', 'fa', 'ur', 'ur_pk', 'yi', 'dv', 'ps', 'ckb', 'ug', 'syr'];
            const langBase = appLanguage.split('-')[0].toLowerCase();
            isRtl = rtlLangs.includes(langBase) || rtlLangs.includes(appLanguage.toLowerCase());
        } else {
            isRtl = layoutDirection === 'rtl';
        }

        document.documentElement.setAttribute('dir', isRtl ? 'rtl' : 'ltr');

        // Wait for both to complete — they've been running in parallel
        await Promise.all([i18nPromise, authPromise]);

        // Load UI font if it requires server fallback font
        if (state.get('user:authenticated') && isFallbackFont(layoutManager.getUiFont())) {
            import('../utils/FontLoader.js').then((module) => {
                module.default.loadFont(layoutManager.getUiFont());
            });
        }

        // 4.5. Initialize Smart Hub Preview (Tizen 4+ only) and Android Launcher Integration
        //      (Android TV Play Next / Channels & Mobile Launcher Shortcuts).
        //      Must run after auth.init() so the managers can read the restored auth
        //      state and start their refresh cycles immediately.
        //      A Smart Hub tile launch is resolved before the router starts (max 3 s),
        //      so the default route can open the tile's page instead of /home.
        if (platformInfo.isTizen) {
            await smartHubManager.init();
        } else if (platformInfo.isAndroid) {
            androidLauncherManager.init();
        }

        // ====================================================================
        // 4.6. Plugin Manager Initialization
        // ====================================================================
        // Initialize Plugin Manager if a user session was successfully restored.
        // On TV platforms (Tizen, WebOS), if multiple cached profiles exist or
        // the active profile is PIN-locked, startup routes to the "Who's Watching"
        // selection screen. In that scenario, we defer initialization until
        // a profile is explicitly selected and unlocked, preventing unauthorized
        // background API requests from firing on the selection screen.
        // On Web browsers, we smartly re-initialize immediately on refresh/boot
        // (unless actively sitting on the profiles selector) so plugins like MDBList,
        // SyncPlay, and SkipIntro remain fully operational across page reloads.
        if (state.get('user:authenticated')) {
            // Count of saved user profiles on the server
            const sessionCount = state.get('user:sessionCount', 0);

            // Retrieve current active user profile ID
            const activeUserId = auth.getCurrentUser()?.Id;

            // Verify if the active user profile has a local PIN lock enabled
            const activeHasPin = activeUserId ? pinManager.hasPin(activeUserId) : false;

            // Check if "Remember Last Active User" preference is enabled
            const rememberLastUser = storage.getItem('pref:rememberLastActiveUser') === 'true';

            // Check if a one-time profile skip is armed (e.g., after user switch reload)
            const skipProfilesOnce = storage.getItem('litefin:skip_profiles_once') === 'true';

            // Check if running on standard web browser or desktop app vs smart TV environment
            const isWeb = platformInfo.isWeb || platformInfo.isDesktop;

            // Inspect the initial hash route to determine target page
            const initialPath = window.location.hash.slice(1) || '/';
            const isProfilesRoute = initialPath === '/profiles';

            // Defer plugin initialization on TVs if we are routing to the profiles screen or PIN gate.
            // On Web browsers, re-initialize immediately on refresh/boot (unless explicitly on the /profiles screen
            // with multiple users or PIN) so plugins remain active across web page reloads.
            const shouldDefer = isWeb
                ? isProfilesRoute && (sessionCount > 1 || activeHasPin)
                : ((sessionCount > 1 && !rememberLastUser) || activeHasPin) && !skipProfilesOnce;

            if (shouldDefer) {
                log.info('Deferring plugin manager initialization: profiles screen or PIN gate is active');
            } else {
                log.info('No profile switcher active or running on web: initializing plugin manager immediately');
                pluginManager
                    .init({
                        api,
                        focusManager,
                        toast: null // Toast component reference wired up once UI is ready
                    })
                    .catch((err) => log.error('pluginManager.init failed:', err));
            }
        }

        // Initialize ScreensaverManager (runs on all pages, handles its own auth checks)
        // Must be initialized after StorageService so it can read delay preferences.
        screensaverManager.init();

        /*
         * ============================================================================
         * PHYSICAL REMOTE BUTTON ENGINE INITIALIZATION
         * ============================================================================
         * Initialize the RemoteButtonManager engine to begin capture of Red, Green,
         * Yellow, and Blue button events propagated from Samsung Tizen / LG WebOS
         * hardware remote adapters. Requires StorageService to be fully operational
         * to load custom button functions successfully.
         * ============================================================================
         */
        remoteButtonManager.init();

        /*
         * ============================================================================
         * HYBRID TIME MANAGER SUBSYSTEM INITIALIZATION
         * ============================================================================
         * Initializes the high-precision platform clock driver (Tizen native time,
         * WebOS Luna service, and Jellyfin LAN server time sync) before any visual
         * clock components or playback timeline controllers render.
         * ============================================================================
         */
        timeManager.init();

        // Initialize Global Clock — persistent time display above all UI
        globalClock.init();

        // Get container element
        if (typeof options.container === 'string') {
            this.container = document.querySelector(options.container);
        } else {
            this.container = options.container || document.getElementById('app');
        }

        if (!this.container) {
            log.error('Container element not found');
            return;
        }

        // Initialize state with defaults
        this._initializeState();

        // Setup global event handlers
        this._setupEventHandlers();

        // ================================================================
        // LAYOUT SETUP
        // ================================================================
        // Create Sidebar Container and Page Container if they don't exist
        // This splits the view into [Sidebar | Page]

        // 1. Setup DOM structure without destroying the initial static splash screen
        if (!document.getElementById('sidebar-container')) {
            this.container.insertAdjacentHTML(
                'afterbegin',
                `
                <div id="sidebar-container">
                    <!-- Order swapped: Sidebar first, then trigger to allow CSS + sibling selector -->
                </div>
                <div id="page-container" class="page-container"></div>
            `
            );
        }

        // 2. Initialize Sidebar (Static import used for Tizen 4 compatibility).
        // Mount the sidebar first, then hide it; we need the sidebar to exist
        // for focus registration, but we'll have it be invisible until the loading sequence completes.
        this.sidebar = new Sidebar();
        this.sidebar.mount(document.getElementById('sidebar-container'));

        /*
         * Initialize Mobile Portrait Navigation Bar & Top Bar.
         * Mounts the responsive mobile navigation components into the application container.
         * Only initialized for mobile/tablet/desktop web contexts — suppressed on TVs
         * (LG webOS, Samsung Tizen, Android TV) to prevent redundant DOM overhead and network calls.
         */
        if (!platformInfo.isTv) {
            this.mobileNav = new MobileNav();
            this.mobileNav.mount(this.container);
        } else {
            this.mobileNav = null;
        }

        // Append trigger AFTER sidebar so we can use sibling selectors in CSS
        document
            .getElementById('sidebar-container')
            .insertAdjacentHTML('beforeend', '<div class="sidebar-hover-trigger"></div>');

        // Hide the sidebar at the CSS level so the GPU layer doesn't render it over the splash screen.
        // We use visibility:hidden + pointer-events:none instead of display:none so the
        // sidebar still occupies its layout space (no flicker-reflow when revealed).
        const sidebarContainer = document.getElementById('sidebar-container');
        if (sidebarContainer) {
            sidebarContainer.style.opacity = '0';
            sidebarContainer.style.pointerEvents = 'none';
        }

        // Setup global splash removal handler - this fires exactly once when the initial page
        // (HomePage, LoginPage, or OfflinePage) finishes its data loading.
        let splashHidden = false;
        eventBus.on('app:hideSplash', () => {
            // Guard against duplicate calls
            if (splashHidden) return;
            splashHidden = true;

            // Reveal the sidebar now that the content beneath is ready
            const sidebar = document.getElementById('sidebar-container');
            if (sidebar) {
                sidebar.style.opacity = '';
                sidebar.style.pointerEvents = '';
            }

            // Notify mobile navigation that splash screen has dropped
            if (this.mobileNav) {
                this.mobileNav.onSplashHidden();
            }

            // Remove the body class that blocks duplicate page-level spinners
            document.body.classList.remove('app-splash-active');

            const splash = document.getElementById('app-splash');
            if (splash) {
                log.info('Hiding initial splash screen');
                splash.classList.add('fade-out');
                setTimeout(() => {
                    if (splash.parentNode) splash.parentNode.removeChild(splash);
                }, 400); // Matches CSS transition duration
            }

            // Trigger auto-update check (respects user settings inside)
            versionChecker.checkAtStartup();

            // ====================================================================
            // Staged Background Prewarming
            // ====================================================================
            // 1. Prewarm primary view chunks (DetailsPage, LibraryPage)
            //    500ms after splash dismissal so user navigation is instantaneous.
            //    LiveTv is excluded: like search, settings and all the seerr/
            //    discover routes it loads strictly on demand through its proxy.
            setTimeout(() => {
                log.info('Prewarming primary view chunks (Details, Library)...');
                Promise.all([loadDetailsPageModule(), loadLibraryPageModule()])
                    .then(() => log.info('Primary view chunks successfully prewarmed in background'))
                    .catch((err) => log.warn('Primary view chunks prewarm warning:', err));
            }, 500);

            // 2. Player chunk is intentionally NOT prewarmed here: it used to
            //    fire 1500ms after splash and steal CPU/RAM from HomePage's
            //    first render. See the LAZY PLAYER CHUNK PREWARMING section -
            //    it now triggers on /details entry or a long idle window.
            if (router.getCurrentPath() !== '/offline') {
                // Idle prewarm would be pure waste while the offline recovery
                // page is up (network dead, playback impossible), so only arm
                // it on real post-login boots. Route changes re-arm it anyway.
                schedulePlayerPrewarm();
            }

            // One-time activity wiring for the lazy player prewarm. Every
            // interaction resets the idle timer; a details entry is
            // playback-likely enough to fetch the chunk, after a 600ms grace
            // period that lets DetailsPage render and paint first.
            eventBus.on('router:navigate', (event) => {
                if (event && typeof event.path === 'string' && event.path.startsWith('/details')) {
                    scheduleDetailsPrewarm();
                    return;
                }
                schedulePlayerPrewarm();
            });
            eventBus.on('focus:changed', () => schedulePlayerPrewarm());
            eventBus.on('focus:activated', () => schedulePlayerPrewarm());
            eventBus.on('key:back', () => schedulePlayerPrewarm());
        });

        // Register routes
        this._registerRoutes();

        // Initialize router (will navigate to current hash or default)
        router.init();

        // 3. Initial Sidebar visibility check
        this._updateSidebarVisibility(router.getCurrentPath());

        this._initialized = true;

        log.info('App initialized successfully');
        eventBus.emit('app:ready');
    }

    /**
     * Update sidebar visibility based on current path
     * @param {string} path
     * @private
     */
    _updateSidebarVisibility(path) {
        if (!this.sidebar) return;

        // Routes that should NOT show the sidebar
        // ProfilesPage is intentionally fullscreen — it IS the user switcher, so
        // showing the sidebar (which contains the active user's name) would be inconsistent.
        const fullScreenRoutes = ['/login', '/offline', '/profiles'];
        const isFullScreen =
            fullScreenRoutes.includes(path) ||
            path.startsWith('/player') ||
            path.startsWith('/slideshow') ||
            path.startsWith('/emulator');

        if (isFullScreen) {
            document.body.classList.add('no-sidebar');
            this.sidebar.setMode('hidden');
            /*
             * Synchronize mobile navigation:
             * On full-screen routes (such as video playback or user switcher),
             * suppress both the top bar and the bottom navbar completely.
             */
            if (this.mobileNav) {
                this.mobileNav.updateVisibility(path, true);
            }
        } else {
            document.body.classList.remove('no-sidebar');

            // Handle Sidebar Modes (Always Hidden or Mixed)
            const sidebarMode = storage.getItem('pref:sidebarMode') || 'shown';
            if (sidebarMode === 'hidden' || (sidebarMode === 'mixed' && path.startsWith('/details'))) {
                document.body.classList.add('sidebar-mode-hidden');
            } else {
                document.body.classList.remove('sidebar-mode-hidden');
            }

            if (sidebarMode === 'collapsed') {
                document.body.classList.add('sidebar-mode-collapsed');
            } else {
                document.body.classList.remove('sidebar-mode-collapsed');
            }

            this.sidebar.setMode('visible');

            /*
             * Synchronize mobile navigation on standard routes:
             * Shows the bottom navbar while evaluating top bar rules
             * (hidden on Settings and Details pages).
             */
            if (this.mobileNav) {
                this.mobileNav.updateVisibility(path, false);
            }
        }

        // Invalidate sidebar cache so FocusManager recognizes newly revealed/hidden items
        focusManager.invalidateCache('sidebar');
    }

    /**
     * Initialize default application state
     * NOTE: Does NOT overwrite auth state - that's handled by auth.init() before this runs
     * @private
     */
    _initializeState() {
        // App settings - only set defaults if not already loaded by layoutManager.init()
        if (!state.has('app:layout')) {
            state.set('app:layout', 'classic'); // 'classic' or 'modern'
        }

        // User state - only set defaults if not already set by auth.init()
        if (!state.has('user:authenticated')) {
            state.set('user:authenticated', false);
        }
        if (!state.has('user:data')) {
            state.set('user:data', null);
        }
        // Safety default — auth.init() sets this before _initializeState() is called,
        // but we guard against the edge case where a restore error prevents it from being set.
        if (!state.has('user:sessionCount')) {
            state.set('user:sessionCount', 0);
        }

        // Server state - only set defaults if not already set
        if (!state.has('server:url')) {
            state.set('server:url', null);
        }
        if (!state.has('server:connected')) {
            state.set('server:connected', false);
        }

        log.debug('App state initialized');
    }

    /**
     * Setup global event handlers
     * @private
     */
    _setupEventHandlers() {
        // Listen for OSD track menu bg opacity changes
        eventBus.on('pref:osdTrackMenuBgOpacity', (value) => {
            document.documentElement.style.setProperty('--osd-track-menu-bg-opacity', (value / 100).toFixed(2));
            cssVarsPolyfill.update();
        });

        // Listen for OSD background gradient opacity changes
        eventBus.on('pref:osdGradientOpacity', (value) => {
            document.documentElement.style.setProperty('--osd-gradient-opacity', (value / 100).toFixed(2));
            cssVarsPolyfill.update();
        });

        // Handle back button / return key
        eventBus.on('key:back', () => {
            // 1. Check for standalone global overlays
            if (syncPlayGroupMenu && syncPlayGroupMenu.isVisible) {
                syncPlayGroupMenu.close();
                return;
            }

            if (exitDialog && exitDialog.isVisible) {
                exitDialog.close();
                return;
            }

            // PIN entry dialog — Back cancels it (aborts the gated action).
            if (pinDialog && pinDialog.isVisible) {
                pinDialog.close(true);
                return;
            }

            // Custom HTTP Headers configuration dialog
            if (customHeadersDialog && customHeadersDialog.isVisible) {
                customHeadersDialog.close();
                return;
            }

            const currentPage = router.getCurrentPage();

            // 1. Try page-specific back handler
            if (currentPage && typeof currentPage.onBack === 'function') {
                const handled = currentPage.onBack();
                if (handled === true) {
                    log.debug('Back event handled by current page');
                    return;
                }
            }

            // 2. Fallback to router history
            if (!router.back()) {
                // No history - show exit confirmation or exit app
                eventBus.emit('app:exitRequested');
            }
        });

        // Track whether the application was genuinely transitioned into the background.
        // Prevents initial window reveal on cold boot from triggering a false "resume" reload.
        let wasBackgrounded = false;

        // Handle app visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                wasBackgrounded = true;
                // App going to background — pause playback and save state,
                // but do NOT stop the session or report stopped. The player
                // stays alive and the server-side session remains active so
                // the user can resume when they return.
                log.debug('App hidden (background)');
                eventBus.emit('app:hidden');
                // Close WebSocket — user appears offline on server dashboard
                api.closeWebSocket();
            } else {
                log.debug('App visible (foreground)');
                eventBus.emit('app:visible');

                // If the app was never hidden first, this is the initial window display on boot.
                // Do NOT trigger resume handlers or reload the active route.
                if (!wasBackgrounded) {
                    return;
                }
                wasBackgrounded = false;

                // Reopen WebSocket when app becomes visible again
                // This makes user appear online again without re-login
                if (state.get('user:authenticated')) {
                    api.openWebSocket();
                }

                // When returning from the background with multiple saved profiles,
                // optionally show "Who's Watching" instead of restoring the previous user.
                // This preference is independent of cold-start auto-login.
                const currentPath = router.getCurrentPath?.() || '';
                const sessionCount = state.get('user:sessionCount', 0);
                const showProfilesOnResume = storage.getItem('pref:showProfilesOnResume') === 'true';

                if (
                    showProfilesOnResume &&
                    state.get('user:authenticated') &&
                    sessionCount > 1 &&
                    currentPath !== '/profiles'
                ) {
                    log.info(`App resumed with ${sessionCount} profiles - showing profile selector`);
                    if (currentPath.startsWith('/player')) {
                        router.getCurrentPage()?.showResumeProfileSelector?.();
                    } else {
                        pluginManager.destroy();
                        router.reset('/profiles');
                    }
                } else {
                    /* =========================================================================
                     * Optional Route Reload on Resume (Performance Preference)
                     * =========================================================================
                     * Enabled by default on TV platforms (Tizen and webOS) where backgrounding
                     * or screen suspend can desynchronize WebSocket connections and stale DOM
                     * data, but disabled by default on web/desktop to preserve in-memory
                     * DOM elements, lazy-loaded datasets, and scroll positions without resets.
                     * If the user manually toggles the setting, their stored preference is respected.
                     * Media playback views (/player) are always spared to avoid interruptions.
                     * ========================================================================= */
                    const isTv =
                        typeof platformInfo !== 'undefined' ? platformInfo.isTizen || platformInfo.isWebOS : true;
                    const savedReload = storage.getItem('pref:reloadOnResume');
                    const reloadOnResume = savedReload !== null ? savedReload === 'true' : isTv;

                    if (reloadOnResume && !currentPath.startsWith('/player')) {
                        log.info(`Reloading active route on resume per performance preference (platform TV: ${isTv})`);
                        router.reload();
                    }
                }
            }
        });

        // Handle app close (browser mode)
        window.addEventListener('beforeunload', () => {
            log.debug('App beforeunload event triggered');
            eventBus.emit('app:beforeExit');
            // Close WebSocket - user goes offline
            api.closeWebSocket();
        });

        // Toggle sidebar visibility based on route
        eventBus.on('router:navigate', ({ path }) => {
            log.debug(`Router navigated to: ${path}`);
            this._updateSidebarVisibility(path);
        });

        // Handle logout / Session Expiry
        eventBus.on('auth:logout', () => {
            log.info('User logged out - resetting to login page');
            // Clear server plugin detection cache on logout (new server/user after login may differ)
            pluginManager.destroy();
            router.reset('/login');
        });

        eventBus.on('auth:expired', () => {
            log.warn('Session expired - resetting to login page');
            pluginManager.destroy();
            router.reset('/login');
        });

        /*
         * auth:switchToProfiles fires when the active user logs out but other
         * sessions are still stored (multi-user scenario). Instead of going to
         * /login, we show the "Who's Watching" profiles screen so the next
         * user can pick their profile without having to re-enter credentials.
         */
        eventBus.on('auth:switchToProfiles', () => {
            log.info('Switching to profiles screen (other sessions remain)');

            // Wrecks active plugin instances and clears server plugin detection cache
            // before redirecting to the user selection view, ensuring no background
            // plugins continue fetching endpoints during the profile select flow.
            pluginManager.destroy();

            router.reset('/profiles');
        });

        // Initialize plugin manager when user successfully logs in
        // (covers fresh logins, not session restores which are handled in init())
        eventBus.on('auth:login', () => {
            log.info('User logged in - initializing plugin manager');

            // If the UI font is fallback-font, load it now that we are authenticated
            if (isFallbackFont(layoutManager.getUiFont())) {
                import('../utils/FontLoader.js').then((module) => {
                    module.default.loadFont(layoutManager.getUiFont());
                });
            }

            pluginManager
                .init({
                    api,
                    focusManager,
                    toast: null // Toast wired up once UI is ready
                })
                .catch((err) => log.error('pluginManager.init (post-login) failed:', err));
        });

        // Handle application exit
        eventBus.on('app:exitRequested', () => {
            log.info('Exit requested - checking settings');

            if (storage.getItem('pref:confirmExit') === 'true') {
                log.info('Confirm exit enabled - showing prompt');
                exitDialog.show();
            } else {
                log.info('Closing application immediately');
                // We DO NOT end the session on the server here.
                // Calling /Sessions/Logout actively revokes the authentication token.
                // The dashboard Offline status is handled automatically by the WebSocket dropping.
                if (platformInfo.isTizen) {
                    tizenAdapter.exit();
                } else if (platformInfo.isWebOS) {
                    webosAdapter.exit();
                } else if (platformInfo.isAndroid) {
                    import('../android/AndroidAdapter.js')
                        .then(({ androidAdapter }) => androidAdapter.exit())
                        .catch((err) => log.warn('AndroidAdapter exit failed:', err));
                } else if (platformInfo.isDesktop) {
                    desktopAdapter.exit();
                } else {
                    webAdapter.exit();
                }
            }
        });

        // ================================================================
        // PLAYER EVENTS
        // ================================================================
        // Handle playback requests from any page (DetailsPage, HomePage, etc.)
        eventBus.on(
            'player:play',
            async ({
                item,
                resume,
                mediaSourceId,
                audioStreamIndex,
                subtitleStreamIndex,
                backdropUrl,
                fromSlideshow,
                fromBrowse,
                ghostMode
            }) => {
                log.info('Playback requested for item:', item?.Name, 'ID:', item?.Id);

                let itemToPlay = item;

                // ================================================================
                // Audio Container Resolution (Albums, Artists, Genres, Playlists)
                // ================================================================
                // Containers cannot be played directly by the video/audio engine; they
                // must resolve to their first constituent track. In Jellyfin:
                // - MusicAlbum tracks are linked by AlbumId (not necessarily ParentId)
                // - MusicArtist tracks are linked by ArtistIds
                // - MusicGenre tracks are linked by GenreIds
                // - Person tracks are linked by PersonIds/ArtistIds
                // - Folders are linked by physical ParentId
                if (
                    item &&
                    ['MusicAlbum', 'MusicArtist', 'MusicGenre', 'Artist', 'Person', 'Folder'].includes(item.Type)
                ) {
                    try {
                        let tracks = null;
                        // For music albums and collections, sort by disc and track number first
                        const albumTrackSort = 'ParentIndexNumber,IndexNumber,SortName';

                        // Case 1: MusicAlbum container — primary query via AlbumIds
                        if (item.Type === 'MusicAlbum') {
                            tracks = await api.getItems({
                                AlbumIds: item.Id,
                                IncludeItemTypes: 'Audio',
                                Limit: 1,
                                SortBy: albumTrackSort,
                                SortOrder: 'Ascending'
                            });

                            // Fallback to ParentId if virtual album mapping is empty
                            if (!tracks?.Items?.length) {
                                tracks = await api.getItems({
                                    ParentId: item.Id,
                                    Recursive: true,
                                    IncludeItemTypes: 'Audio',
                                    Limit: 1,
                                    SortBy: albumTrackSort,
                                    SortOrder: 'Ascending'
                                });
                            }
                        }
                        // Case 2: MusicArtist or Artist container — query via ArtistIds
                        else if (item.Type === 'MusicArtist' || item.Type === 'Artist') {
                            tracks = await api.getItems({
                                ArtistIds: item.Id,
                                IncludeItemTypes: 'Audio',
                                Limit: 1,
                                SortBy: albumTrackSort,
                                SortOrder: 'Ascending'
                            });

                            // Fallback to ParentId if artist is folder-based
                            if (!tracks?.Items?.length) {
                                tracks = await api.getItems({
                                    ParentId: item.Id,
                                    Recursive: true,
                                    IncludeItemTypes: 'Audio',
                                    Limit: 1,
                                    SortBy: 'SortName',
                                    SortOrder: 'Ascending'
                                });
                            }
                        }
                        // Case 3: MusicGenre container — query via GenreIds
                        else if (item.Type === 'MusicGenre') {
                            tracks = await api.getItems({
                                GenreIds: item.Id,
                                IncludeItemTypes: 'Audio',
                                Limit: 1,
                                SortBy: albumTrackSort,
                                SortOrder: 'Ascending'
                            });

                            // Fallback to ParentId
                            if (!tracks?.Items?.length) {
                                tracks = await api.getItems({
                                    ParentId: item.Id,
                                    Recursive: true,
                                    IncludeItemTypes: 'Audio',
                                    Limit: 1,
                                    SortBy: 'SortName',
                                    SortOrder: 'Ascending'
                                });
                            }
                        }
                        // Case 4: Person (contributor/performer) container — query via PersonIds or ArtistIds
                        else if (item.Type === 'Person') {
                            tracks = await api.getItems({
                                PersonIds: item.Id,
                                IncludeItemTypes: 'Audio',
                                Limit: 1,
                                SortBy: albumTrackSort,
                                SortOrder: 'Ascending'
                            });

                            if (!tracks?.Items?.length) {
                                tracks = await api.getItems({
                                    ArtistIds: item.Id,
                                    IncludeItemTypes: 'Audio',
                                    Limit: 1,
                                    SortBy: albumTrackSort,
                                    SortOrder: 'Ascending'
                                });
                            }
                        }
                        // Case 5: Folder or generic directory container
                        else {
                            tracks = await api.getItems({
                                ParentId: item.Id,
                                Recursive: true,
                                IncludeItemTypes: 'Audio',
                                Limit: 1,
                                SortBy: albumTrackSort,
                                SortOrder: 'Ascending'
                            });
                        }

                        // Verify that at least one playable audio track was resolved
                        if (tracks?.Items && tracks.Items.length > 0) {
                            itemToPlay = tracks.Items[0];
                            itemToPlay.contextType = 'music';
                            itemToPlay.contextId = item.Id;
                            log.info('Resolved music container to first track:', itemToPlay.Name);
                        } else {
                            log.warn('No playable audio tracks found in container:', item.Id);
                            return;
                        }
                    } catch (e) {
                        log.error('Failed to resolve audio container tracks:', e);
                        return;
                    }
                }

                // Playlist items are containers with no direct MediaSource.
                // Resolve to the first item and tag context so PlayQueue builds the full list.
                if (item && item.Type === 'Playlist' && itemToPlay === item) {
                    try {
                        const result = await api.getPlaylistItems(item.Id, { Limit: 1 });
                        if (result.Items && result.Items.length > 0) {
                            itemToPlay = result.Items[0];
                            itemToPlay.contextType = 'playlist';
                            itemToPlay.contextId = item.Id;
                            log.info('Resolved Playlist to first item:', itemToPlay.Name);
                        } else {
                            log.warn('Playlist is empty:', item.Id);
                            return;
                        }
                    } catch (e) {
                        log.error('Failed to resolve playlist:', e);
                        return;
                    }
                }

                // Store playback context for play queue building (e.g. 'boxset', 'music')
                // IMPORTANT: Always set these (even to null) to avoid context leaking from previous plays
                state.set('player:contextType', itemToPlay?.contextType || null);
                state.set('player:contextId', itemToPlay?.contextId || null);
                // For BoxSet playback, forward the sort order so PlayQueue builds the
                // full queue in the same order the collection grid is displayed.
                state.set('player:boxsetSortBy', itemToPlay?.boxsetSortBy || null);

                // Store explicit trailer metadata overrides since the player re-fetches the item
                // and loses the parent context injected by DetailsPage.
                if (itemToPlay && itemToPlay.Type === 'Trailer') {
                    state.set('player:overrideName', itemToPlay.Name || null);
                    state.set(
                        'player:overrideYear',
                        itemToPlay.ProductionYear !== undefined ? itemToPlay.ProductionYear : 'NONE'
                    );
                } else {
                    state.set('player:overrideName', null);
                    state.set('player:overrideYear', null);
                }

                // Store backdrop URL for loading screen transition
                state.set('player:backdropUrl', backdropUrl || null);

                if (!itemToPlay?.Id) {
                    log.error('Cannot play - no item ID provided for playback request');
                    return;
                }

                // Store track selection in state for PlayerPage to consume
                if (mediaSourceId !== undefined) {
                    state.set('player:initialMediaSourceId', mediaSourceId);
                    log.debug(`Setting initial media source ID: ${mediaSourceId}`);
                }
                if (audioStreamIndex !== undefined) {
                    state.set('player:initialAudioIndex', audioStreamIndex);
                    log.debug(`Setting initial audio stream index: ${audioStreamIndex}`);
                }
                if (subtitleStreamIndex !== undefined) {
                    state.set('player:initialSubtitleIndex', subtitleStreamIndex);
                    log.debug(`Setting initial subtitle stream index: ${subtitleStreamIndex}`);
                }

                // Navigate to player page with item ID and resume flag.
                // fromSlideshow and fromBrowse (the Home/Library Play key) both
                // mark launchers that should PUSH the player, so Back/Stop returns
                // to the originating page (see replace flag below).
                const resumeParam = resume ? 'true' : 'false';
                const queryParts = [];
                if (fromSlideshow) queryParts.push('fromSlideshow=true');
                if (fromBrowse) queryParts.push('fromBrowse=true');
                if (ghostMode) queryParts.push('ghostMode=true');

                // Determine referrer context to handle exit routing cleanly.
                // If we are playing from a details screen or the Live TV guide,
                // we want to ensure we navigate back to the correct view on exit.
                const currentPath = router.getCurrentPath?.() || '';
                if (currentPath.startsWith('/details/')) {
                    queryParts.push('fromDetails=true');
                } else if (currentPath.startsWith('/livetv')) {
                    queryParts.push('fromGuide=true');
                }

                const queryParam = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

                // SyncPlay Override: if we are in a SyncPlay group, we do NOT launch the player locally.
                // Instead, we command the server to start playback of the new item. The server
                // will broadcast a PlayQueue update to everyone (including us), which triggers the actual navigation.
                if (window.__syncPlayManager && window.__syncPlayManager.isEnabled) {
                    log.info('SyncPlay is active. Sending SetNewQueue command instead of local launch.');
                    try {
                        let startPosition = 0;
                        if (resume && itemToPlay.UserData?.PlaybackPositionTicks) {
                            /*
                             * Apply configured resume rewind offset so that all group participants
                             * start with the same contextual scene rewind when resuming.
                             */
                            startPosition = PlayerSettings.getAdjustedResumePositionTicks(
                                itemToPlay.UserData.PlaybackPositionTicks
                            );
                        }
                        await api.post('/SyncPlay/SetNewQueue', {
                            PlayingQueue: [itemToPlay.Id],
                            PlayingItemPosition: 0,
                            StartPositionTicks: startPosition
                        });
                    } catch (err) {
                        log.error('Failed to send SetNewQueue to SyncPlay:', err);
                    }
                    return;
                }

                // If we came from a slideshow, a browse-page Play key, or the Live TV guide,
                // we PUSH the player so we can go BACK to the originating page exactly where
                // we left off. The Live TV case is critical: replacing /livetv in history
                // destroys the saved tab, EPG scroll position, and focused program, so
                // pressing Back from the player lands the user on a blank suggestions tab
                // with no focus (stuck). Pushing the player keeps /livetv alive in history.
                //
                // For DetailsPage launches we still REPLACE to prevent history bloat.
                //
                // Web and Android Mobile exception:
                // On standard web browsers and Android mobile devices, we do NOT replace
                // the Details page so that the system / browser back stack remains intact.
                //
                // Desktop and TV platforms (Tizen, webOS, Android TV):
                // We REPLACE the Details page when entering the player to prevent
                // navigation history stack bloat and avoid redundant detail page instances.
                const isWebOrMobile = platformInfo.isWeb || (platformInfo.isAndroid && !platformInfo.isAndroidTv);
                const isFromLiveTv = currentPath.startsWith('/livetv');
                const shouldReplace = !fromSlideshow && !fromBrowse && !isFromLiveTv && !isWebOrMobile;

                router.navigate(`/player/${itemToPlay.Id}/${resumeParam}${queryParam}`, {
                    replace: shouldReplace
                });
            }
        );

        // ================================================================
        // WebSocket Remote Control
        // ================================================================
        // Initialize handler for remote commands from Jellyfin dashboard
        webSocketHandler.init();
        log.debug('WebSocketHandler initialized for remote control');

        // Handle remote:playnow - start playback of item from server
        //
        // The Jellyfin server sends this for two distinct scenarios:
        //   1. Plain "start playing this item" — typical remote control play
        //   2. Queue manipulation (reorder / remove / jump-to-item) sent while
        //      we are already playing.  In that case the server sends the FULL
        //      new ordered item list plus StartIndex indicating the active slot.
        //
        // We route case (2) directly to PlayerPage via remote:queueupdate so it
        // can rebuild PlayQueue in-place without a full page navigation.
        eventBus.on('remote:playnow', async ({ itemIds, startIndex, startPositionTicks }) => {
            log.info(
                'Remote playnow:',
                itemIds?.length,
                'items, startIndex:',
                startIndex,
                'position:',
                startPositionTicks
            );

            if (!itemIds || itemIds.length === 0) {
                log.warn('Remote playnow received without item IDs — ignoring');
                return;
            }

            // ----------------------------------------------------------------
            // Case A: Player is already active → in-place queue update.
            // We can detect this by checking if the current route is /player/*.
            // PlayerPage will handle fetching items and rebuilding the queue.
            // ----------------------------------------------------------------
            const currentPath = router.getCurrentPath?.() || '';
            if (currentPath.startsWith('/player')) {
                log.info('Remote playnow: player active — emitting remote:queueupdate');
                eventBus.emit('remote:queueupdate', {
                    itemIds,
                    startIndex: startIndex || 0,
                    startPositionTicks: startPositionTicks || 0
                });
                return;
            }

            // ----------------------------------------------------------------
            // Case B: No player running — fetch the target item and navigate.
            // Use startIndex (default 0) to pick the correct starting item.
            // ----------------------------------------------------------------
            const targetId = itemIds[startIndex || 0] || itemIds[0];

            try {
                const item = await api.getItem(targetId);
                if (item) {
                    log.debug('Remote playnow: navigating to player for item', item.Name);
                    eventBus.emit('player:play', {
                        item,
                        resume: startPositionTicks > 0
                    });
                } else {
                    log.warn('Remote playnow: Item not found for ID:', targetId);
                }
            } catch (e) {
                log.error('Failed to handle remote:playnow command:', e.message || e);
            }
        });

        // Navigation commands - handle when not in player
        eventBus.on('remote:home', () => {
            log.info('Remote home command received');
            router.navigate('/home');
        });

        eventBus.on('remote:back', () => {
            router.back();
        });

        log.debug('Event handlers setup');
    }

    /**
     * Obsolete: Do not call this method.
     * Ending the session via /Sessions/Logout permanently revokes the user's access token,
     * which causes a 401 Unauthorized error on the next launch.
     * @private
     */
    _endSessionOnServer() {
        // Obsolete - intentionally empty
    }

    /**
     * Register application routes
     * @private
     */
    _registerRoutes() {
        // Registration is synchronous (class references only); heavy page modules
        // resolve lazily through the async chunk proxies declared above.

        // Register all routes
        router.register('/login', LoginPage);
        router.register('/profiles', ProfilesPage);
        router.register('/home', HomePage);
        router.register('/library/:id', LibraryPage);
        router.register('/library/:id/genre/:genreId', LibraryPage); // Filtered by Genre
        router.register('/library/:id/studio/:studioId', LibraryPage); // Filtered by Studio/Network
        router.register('/library/:id/year/:year', LibraryPage); // Filtered by Year
        router.register('/library/:id/person/:personId', LibraryPage); // Filtered by Person
        router.register('/library/:id/tag/:tagName', LibraryPage); // Filtered by Tag
        router.register('/details/:id', DetailsPage);
        router.register('/seerr/person/:id', SeerrPersonPage);
        router.register('/seerr/:mediaType/:tmdbId', SeerrDetailsPage);
        router.register('/person/:id', PersonPage);
        router.register('/search', SearchPage);
        router.register('/discover', DiscoverPage);
        router.register('/favorites', FavoritesPage);
        router.register('/settings', SettingsPage);
        router.register('/livetv', LiveTvPage);
        router.register('/offline', OfflinePage);
        router.register('/slideshow/:photoId', SlideshowPage);
        router.register('/player/:id/:resume', PlayerPage); // Video player page (async chunk)
        router.register('/emulator/:id', EmulatorPage); // JellyEmu game player page

        // Season redirect (for backward compatibility or deep links)
        router.register('/series/:id/season/:seasonId', {
            init: (params) => {
                router.navigate(`/details/${params.seasonId}`, { replace: true });
            }
        });

        // Default route — check auth and redirect appropriately.
        // With multi-user support we now consider the number of stored sessions:
        //   • Offline          → /offline
        //   • ≥2 sessions      → /profiles ("Who's Watching" prompt)
        //   • 1 session, valid → /home (same auto-login as before)
        //   • 0 sessions       → /login
        router.register('/', {
            init: () => {
                const isOffline = state.get('server:offline');
                const isAuthenticated = state.get('user:authenticated');
                const sessionCount = state.get('user:sessionCount', 0);
                // If the restored profile is PIN-locked, never silently auto-resume
                // it — force the profile picker so ProfilesPage._switchToUser runs
                // the PIN gate before any content is shown.
                const activeUserId = auth.getCurrentUser()?.Id;
                const activeHasPin = activeUserId ? pinManager.hasPin(activeUserId) : false;

                const skipProfilesOnce = storage.getItem('litefin:skip_profiles_once') === 'true';
                if (skipProfilesOnce) {
                    storage.removeItem('litefin:skip_profiles_once');
                    storage.flush();
                }

                /*
                 * Check user preference: "Remember Last Active User".
                 * When enabled, the app skips the profile picker on launch and boots directly
                 * into the last active session (unless protected by a local PIN).
                 * Default: disabled (false).
                 */
                const rememberLastUser = storage.getItem('pref:rememberLastActiveUser') === 'true';

                if (isOffline) {
                    // Saved session exists but server is unreachable
                    log.info('Initial route: Server is offline, navigating to OfflinePage');
                    router.navigate('/offline', { replace: true });
                } else if (
                    isAuthenticated &&
                    ((sessionCount > 1 && !rememberLastUser) || activeHasPin) &&
                    !skipProfilesOnce
                ) {
                    // Multiple users stored (and remember last user is disabled), or the restored profile is PIN-locked —
                    // make them pick a profile (which enforces any PIN).
                    log.info(
                        `Initial route: navigating to ProfilesPage (sessions=${sessionCount}, pinLocked=${activeHasPin}, rememberLastUser=${rememberLastUser})`
                    );
                    router.navigate('/profiles', { replace: true });
                } else if (isAuthenticated) {
                    // Launched from a Smart Hub tile: open its page instead (Back leads to /home)
                    if (smartHubManager.openStartupTarget()) return;

                    // Single user, no PIN, rememberLastUser active, or skipped once — skip the profiles screen and go straight home
                    log.info('Initial route: Authenticated, navigating to HomePage');
                    router.navigate('/home', { replace: true });
                } else {
                    log.info('Initial route: No session, navigating to LoginPage');
                    router.navigate('/login', { replace: true });
                }
            }
        });

        log.debug('Routes registered');
    }

    /**
     * Get current layout mode
     * @returns {string} 'classic' or 'modern'
     */
    getLayout() {
        return layoutManager.getLayout();
    }

    /**
     * Set layout mode
     * @param {string} layout - 'classic' or 'modern'
     */
    setLayout(layout) {
        layoutManager.setLayout(layout);
    }
}

// Export singleton instance
export const app = new App();

// Also export class for testing
export default App;
