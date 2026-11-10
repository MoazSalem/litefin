/**
 * ============================================================================
 * Performance Diagnostic Debug Overlay
 * ============================================================================
 * Comprehensive real-time performance telemetry and diagnostic HUD.
 * Tracks frame rates, 1% low frame time percentiles, live canvas performance
 * graph, Core Web Vitals (LCP, FCP, CLS, INP, TTFB), and memory allocation.
 *
 * Designed to be deferred and lazy-loaded on demand to ensure zero footprint
 * during normal runtime and initial application boot.
 * ============================================================================
 */

import { storage } from '../../utils/StorageService.js';
import { router } from '../../core/Router.js';
import { platformInfo } from '../../utils/PlatformInfo.js';
import { escapeHtml } from '../../utils/Utils.js';

/**
 * Universal animation frame requester supporting environments without global RAF.
 * @param {Function} cb Frame callback
 * @returns {number} Timer or RAF ID
 */
function requestFrame(cb) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        return window.requestAnimationFrame(cb);
    }
    return setTimeout(() => cb(Date.now()), 16);
}

/**
 * Universal animation frame canceller.
 * @param {number} id Timer or RAF ID
 */
function cancelFrame(id) {
    if (typeof cancelAnimationFrame === 'function') return cancelAnimationFrame(id);
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        return window.cancelAnimationFrame(id);
    }
    clearTimeout(id);
}

/**
 * Diagnostic overlay class tracking framerate, layout stability, and Web Vitals.
 */
export class PerformanceDiagnosticOverlay {
    /**
     * Instantiates internal state registries and buffers for metrics tracking.
     */
    constructor() {
        // Overlay mount and visibility flags
        this._initialized = false;
        this._isVisible = false;
        this._container = null;
        this._stylesLoaded = false;

        // Display configuration states
        this._mode = 'full'; // 'full' or 'compact'
        this._position = 'top-right'; // 'top-right', 'top-left', 'bottom-right', 'bottom-left'
        this._activeTab = 'fps'; // 'fps', 'vitals', 'system'
        this._isClickThrough = false;

        // Custom coordinates when dragged by user
        this._dragCoord = null;
        this._isDragging = false;
        this._dragOffset = { x: 0, y: 0 };
        this._justDragged = false;

        // Frame rate monitoring telemetry
        this._rafId = null;
        this._lastFrameTime = 0;
        this._frameTimes = []; // Circular ring buffer of recent frame intervals in ms
        this._maxHistorySamples = 120; // Number of samples displayed on performance graph
        this._sessionFrames = 0;
        this._sessionDurationMs = 0;

        // Calculated frame rate aggregates
        this._currentFps = 60;
        this._minFps = Infinity;
        this._maxFps = 0;
        this._avgFps = 60;
        this._onePercentLowFps = 60;
        this._currentFrameTimeMs = 16.6;
        this._jankCount = 0;
        this._detectedRefreshRate = 60;

        // Performance Observer instances for Web Vitals collection
        this._observers = [];

        // Collected Core Web Vitals metrics
        this._vitals = {
            lcp: null, // Largest Contentful Paint in ms
            lcpElement: 'N/A', // Tag and selector of element that triggered LCP
            fcp: null, // First Contentful Paint in ms
            cls: 0, // Cumulative Layout Shift score
            inp: null, // Interaction to Next Paint in ms
            fid: null, // First Input Delay in ms
            ttfb: null // Time to First Byte in ms
        };

        // Throttled interval identifier for DOM telemetry text updates
        this._textUpdateInterval = null;

        // Bound event listeners tracking for deterministic cleanup
        this._listeners = [];

        // Canvas context caching for graph rendering
        this._canvas = null;
        this._ctx = null;
    }

    /**
     * Initializes the diagnostic subsystem, restores persisted preferences,
     * registers PerformanceObserver hooks, and constructs UI markup.
     */
    init() {
        if (this._initialized) return;

        // Load persisted settings from local storage
        const savedMode = storage.getItem('debug_perf_mode');
        if (savedMode === 'compact' || savedMode === 'full') {
            this._mode = savedMode;
        }

        const savedPosition = storage.getItem('debug_perf_position');
        if (savedPosition) {
            this._position = savedPosition;
        }

        this._isClickThrough = storage.getItem('debug_perf_clickthrough') === 'true';

        // Preload stylesheet chunk on demand
        this._ensureStyles();

        // Initialize Core Web Vitals observers
        this._setupWebVitalsObservers();

        // Extract navigation timing for initial TTFB
        this._collectNavigationTiming();

        // Construct and insert DOM tree into root document body
        this._buildDom();

        // Bind interactive dragging and control handlers
        this._bindEvents();

        this._initialized = true;
    }

    /**
     * Reveals the overlay, mounts RAF render pipeline, and begins sampling.
     */
    show() {
        if (!this._initialized) {
            this.init();
        }

        if (this._container) {
            this._container.style.display = 'block';
        }

        this._isVisible = true;

        // Reset frame baseline to prevent giant delta spike on resume
        this._lastFrameTime = performance.now();

        // Start requestAnimationFrame loop for continuous frame timing
        if (!this._rafId) {
            this._rafId = requestFrame((now) => this._onAnimationFrame(now));
        }

        // Run throttled text updates every 250ms to keep CPU overhead negligible
        if (!this._textUpdateInterval) {
            this._textUpdateInterval = setInterval(() => this._updateMetricsDisplay(), 250);
        }

        // Render initial UI pass
        this._updateMetricsDisplay();
    }

    /**
     * Hides the overlay and stops active rendering loops to conserve cycles.
     */
    hide() {
        this._isVisible = false;

        // Suspend animation frame loop
        if (this._rafId) {
            cancelFrame(this._rafId);
            this._rafId = null;
        }

        // Suspend throttled interval updates
        if (this._textUpdateInterval) {
            clearInterval(this._textUpdateInterval);
            this._textUpdateInterval = null;
        }

        // Hide root DOM container
        if (this._container) {
            this._container.style.display = 'none';
        }
    }

    /**
     * Completely unmounts the overlay, disconnects observers, and frees memory.
     */
    destroy() {
        this.hide();

        // Disconnect all performance observers to prevent background callbacks
        for (let i = 0; i < this._observers.length; i++) {
            try {
                this._observers[i].disconnect();
            } catch (_) {}
        }
        this._observers = [];

        // Unbind and clear all registered DOM listeners
        for (let i = 0; i < this._listeners.length; i++) {
            const { element, event, handler } = this._listeners[i];
            if (element && typeof element.removeEventListener === 'function') {
                element.removeEventListener(event, handler);
            }
        }
        this._listeners = [];

        // Remove overlay DOM element from document body
        if (this._container && this._container.parentNode) {
            this._container.parentNode.removeChild(this._container);
        }

        this._container = null;
        this._canvas = null;
        this._ctx = null;
        this._initialized = false;
    }

    /**
     * Toggles between full expanded telemetry panel and compact status pill.
     * Uses CSS data attributes on the persistent container to switch layout
     * visibility without incurring innerHTML rebuilds or listener invalidation.
     * @param {'full'|'compact'} mode Desired display mode
     */
    setMode(mode) {
        if (mode !== 'full' && mode !== 'compact') return;

        // Persist user preference to local storage
        this._mode = mode;
        storage.setItem('debug_perf_mode', mode);

        // Switch visible view in DOM via data-mode attribute
        if (this._container) {
            this._container.setAttribute('data-mode', mode);
        }

        // If the overlay was manually dragged, re-clamp to prevent overflow in newly expanded state
        if (this._dragCoord) {
            this._reconstrainPosition();
        }

        // Ensure canvas graphics context is attached when expanding to full mode
        if (mode === 'full') {
            this._bindCanvas();
        }

        // Refresh text metrics for newly displayed layout
        this._updateMetricsDisplay();
    }

    /**
     * Switches the active telemetry tab and updates navigation styles.
     * @param {'fps'|'vitals'|'system'} tab Target tab identifier
     */
    setActiveTab(tab) {
        if (!this._container) return;
        this._activeTab = tab;

        // Update tab navigation button styles
        const tabBtns = this._container.querySelectorAll('.perf-tab-btn');
        tabBtns.forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        // Toggle corresponding tab panel visibility
        const fpsTab = this._container.querySelector('#perf-tab-content-fps');
        const vitalsTab = this._container.querySelector('#perf-tab-content-vitals');
        const systemTab = this._container.querySelector('#perf-tab-content-system');

        if (fpsTab) fpsTab.style.display = tab === 'fps' ? 'block' : 'none';
        if (vitalsTab) vitalsTab.style.display = tab === 'vitals' ? 'block' : 'none';
        if (systemTab) systemTab.style.display = tab === 'system' ? 'block' : 'none';

        // Bind canvas context if switching back to framerate tab
        if (tab === 'fps') {
            this._bindCanvas();
        }
    }

    /**
     * Sets the anchor corner in the viewport.
     * @param {'top-right'|'top-left'|'bottom-right'|'bottom-left'} pos Corner identifier
     */
    setPosition(pos) {
        this._position = pos;
        this._dragCoord = null; // Clear manual drag offset when docking
        storage.setItem('debug_perf_position', pos);

        if (this._container) {
            this._container.setAttribute('data-position', pos);
            this._container.removeAttribute('data-dragged');
            this._container.style.left = '';
            this._container.style.right = '';
            this._container.style.top = '';
            this._container.style.bottom = '';
            this._container.style.transform = '';
        }
    }

    /**
     * Toggles pointer events pass-through mode on the overlay body.
     * @param {boolean} [enable] Optional explicit state
     */
    toggleClickThrough(enable) {
        this._isClickThrough = enable !== undefined ? enable : !this._isClickThrough;
        storage.setItem('debug_perf_clickthrough', this._isClickThrough);

        if (this._container) {
            if (this._isClickThrough) {
                this._container.classList.add('perf-clickthrough');
            } else {
                this._container.classList.remove('perf-clickthrough');
            }
        }

        const clickBtn = this._container ? this._container.querySelector('#perf-btn-clickthrough') : null;
        if (clickBtn) {
            clickBtn.classList.toggle('active', this._isClickThrough);
        }
    }

    /**
     * Resets framerate statistics, 1% low calculations, and clearing graphs.
     */
    resetMetrics() {
        this._frameTimes = [];
        this._sessionFrames = 0;
        this._sessionDurationMs = 0;
        this._minFps = Infinity;
        this._maxFps = 0;
        this._avgFps = this._detectedRefreshRate || 60;
        this._onePercentLowFps = this._detectedRefreshRate || 60;
        this._jankCount = 0;

        // Clear canvas context
        if (this._canvas && this._ctx) {
            this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        }

        this._updateMetricsDisplay();
    }

    /**
     * Lazily loads the component stylesheet chunk upon first activation.
     * Guarded to prevent non-browser test runners from throwing unknown extension errors.
     * @private
     */
    _ensureStyles() {
        if (this._stylesLoaded) return;
        this._stylesLoaded = true;

        /*
         * Dynamically load overlay stylesheet into document head.
         * Bypasses execution in Node.js unit test environments.
         */
        const isNode =
            typeof globalThis.process !== 'undefined' &&
            typeof globalThis.process.versions !== 'undefined' &&
            Boolean(globalThis.process.versions.node);
        if (typeof window !== 'undefined' && !isNode) {
            import(/* webpackChunkName: "perf-overlay-css" */ '../../styles/performance-overlay.css')
                .catch((err) => {
                    this._stylesLoaded = false;
                });
        }
    }

    /**
     * Sets up modern PerformanceObserver hooks for Core Web Vitals.
     * Safely guards against missing or partial browser API implementations.
     * @private
     */
    _setupWebVitalsObservers() {
        // Verify PerformanceObserver availability
        if (typeof PerformanceObserver === 'undefined') return;

        const supportedTypes = PerformanceObserver.supportedEntryTypes || [];

        // 1. Largest Contentful Paint (LCP)
        if (supportedTypes.includes('largest-contentful-paint')) {
            try {
                const lcpObserver = new PerformanceObserver((entryList) => {
                    const entries = entryList.getEntries();
                    const lastEntry = entries[entries.length - 1];
                    if (lastEntry) {
                        this._vitals.lcp = Math.round(lastEntry.startTime);

                        // Capture human-readable identifier of the candidate element
                        if (lastEntry.element) {
                            const tag = lastEntry.element.tagName ? lastEntry.element.tagName.toLowerCase() : 'element';
                            const id = lastEntry.element.id ? `#${lastEntry.element.id}` : '';
                            const cls = lastEntry.element.className && typeof lastEntry.element.className === 'string'
                                ? `.${lastEntry.element.className.trim().split(/\s+/)[0]}`
                                : '';
                            this._vitals.lcpElement = `${tag}${id}${cls}` || tag;
                        } else if (lastEntry.id) {
                            this._vitals.lcpElement = `#${lastEntry.id}`;
                        } else if (lastEntry.url) {
                            const parts = lastEntry.url.split('/');
                            this._vitals.lcpElement = parts[parts.length - 1] || 'image';
                        }
                    }
                });

                lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
                this._observers.push(lcpObserver);
            } catch (err) {
                // Non-fatal observer exception on constrained runtimes
            }
        }

        // 2. First Contentful Paint (FCP)
        if (supportedTypes.includes('paint')) {
            try {
                const paintObserver = new PerformanceObserver((entryList) => {
                    for (const entry of entryList.getEntries()) {
                        if (entry.name === 'first-contentful-paint') {
                            this._vitals.fcp = Math.round(entry.startTime);
                        }
                    }
                });

                paintObserver.observe({ type: 'paint', buffered: true });
                this._observers.push(paintObserver);
            } catch (_) {}
        }

        // 3. Cumulative Layout Shift (CLS)
        if (supportedTypes.includes('layout-shift')) {
            try {
                let cumulativeScore = 0;
                const clsObserver = new PerformanceObserver((entryList) => {
                    for (const entry of entryList.getEntries()) {
                        // Only count unexpected shifts outside recent user interaction
                        if (!entry.hadRecentInput) {
                            cumulativeScore += entry.value;
                            this._vitals.cls = Number(cumulativeScore.toFixed(3));
                        }
                    }
                });

                clsObserver.observe({ type: 'layout-shift', buffered: true });
                this._observers.push(clsObserver);
            } catch (_) {}
        }

        // 4. First Input Delay (FID)
        if (supportedTypes.includes('first-input')) {
            try {
                const fidObserver = new PerformanceObserver((entryList) => {
                    const firstInput = entryList.getEntries()[0];
                    if (firstInput) {
                        this._vitals.fid = Math.round(firstInput.processingStart - firstInput.startTime);
                    }
                });

                fidObserver.observe({ type: 'first-input', buffered: true });
                this._observers.push(fidObserver);
            } catch (_) {}
        }

        // 5. Interaction to Next Paint (INP)
        if (supportedTypes.includes('event')) {
            try {
                const inpObserver = new PerformanceObserver((entryList) => {
                    for (const entry of entryList.getEntries()) {
                        if (entry.duration && entry.duration > (this._vitals.inp || 0)) {
                            this._vitals.inp = Math.round(entry.duration);
                        }
                    }
                });

                inpObserver.observe({ type: 'event', buffered: true, durationThreshold: 16 });
                this._observers.push(inpObserver);
            } catch (_) {}
        }
    }

    /**
     * Resolves Time to First Byte (TTFB) from Navigation Timing entries.
     * @private
     */
    _collectNavigationTiming() {
        try {
            if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
                const navEntries = performance.getEntriesByType('navigation');
                if (navEntries && navEntries.length > 0) {
                    const nav = navEntries[0];
                    this._vitals.ttfb = Math.round(nav.responseStart);
                    return;
                }
            }

            // Fallback for legacy webview timing dictionaries
            if (typeof performance !== 'undefined' && performance.timing) {
                const start = performance.timing.navigationStart;
                const resp = performance.timing.responseStart;
                if (resp && start && resp >= start) {
                    this._vitals.ttfb = Math.round(resp - start);
                }
            }
        } catch (_) {}
    }

    /**
     * Constructs root container element and renders persistent DOM hierarchy.
     * Both the compact status pill and the full telemetry HUD panel are mounted
     * into the DOM simultaneously to eliminate runtime innerHTML serialization
     * churn, garbage collection pauses, and dropped event listeners.
     * @private
     */
    _buildDom() {
        if (this._container) return;

        // Create main overlay container element
        this._container = document.createElement('div');
        this._container.id = 'performance-diagnostic-overlay';

        // Configure persistent layout attributes
        this._container.setAttribute('data-position', this._position);
        this._container.setAttribute('data-mode', this._mode);

        // Apply click-through mode if persisted
        if (this._isClickThrough) {
            this._container.classList.add('perf-clickthrough');
        }

        // Overlay remains hidden until explicitly invoked via show()
        this._container.style.display = 'none';

        // Mount both compact pill and full panel simultaneously into DOM
        this._container.innerHTML = `
            ${this._getCompactPillHtml()}
            ${this._getFullHudHtml()}
        `;

        // Cache 2D canvas context for performance graphing
        this._bindCanvas();

        // Attach overlay element directly to document body root
        document.body.appendChild(this._container);
    }

    /**
     * Synchronizes DOM attributes with the active display mode.
     * With dual persistent DOM templates, this eliminates innerHTML destruction.
     * @private
     */
    _renderContent() {
        if (!this._container) return;

        // Synchronize mode attribute with current state
        this._container.setAttribute('data-mode', this._mode);

        // Re-bind canvas reference when in full mode
        if (this._mode === 'full') {
            this._bindCanvas();
        }
    }

    /**
     * Returns serialized HTML for the compact pill badge.
     * @private
     */
    _getCompactPillHtml() {
        return `
            <div class="perf-pill" id="perf-pill-root" role="button" tabindex="0" title="Drag to move, click to expand">
                <div class="perf-status-dot" id="perf-pill-dot"></div>
                <div class="perf-pill-item">
                    <span class="perf-pill-val" id="perf-pill-fps">--</span>
                    <span class="perf-pill-unit">FPS</span>
                </div>
                <div class="perf-pill-divider"></div>
                <div class="perf-pill-item">
                    <span class="perf-pill-unit">LCP</span>
                    <span class="perf-pill-val" id="perf-pill-lcp">--</span>
                </div>
                <div class="perf-pill-divider"></div>
                <div class="perf-pill-item">
                    <span class="perf-pill-val" id="perf-pill-mem">--</span>
                    <span class="perf-pill-unit">MB</span>
                </div>
                <button type="button" class="perf-pill-expand-btn" id="perf-btn-expand" title="Expand Full HUD" aria-label="Expand Full HUD">
                    <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                </button>
            </div>
        `;
    }

    /**
     * Returns serialized HTML for the full telemetry panel.
     * @private
     */
    _getFullHudHtml() {
        return `
            <div class="perf-hud-panel" id="perf-hud-panel-root" role="region" aria-label="Performance Diagnostics">
                <!-- Header Toolbar with Drag Handle -->
                <div class="perf-hud-header" id="perf-hud-header">
                    <div class="perf-hud-title-group">
                        <div class="perf-status-dot"></div>
                        <span class="perf-hud-title">Performance HUD</span>
                        <span class="perf-badge-target-hz" id="perf-hz-badge">60Hz</span>
                    </div>
                    <div class="perf-hud-controls">
                        <!-- Click-Through Passthrough Toggle -->
                        <button type="button" 
                                class="perf-btn-icon ${this._isClickThrough ? 'active' : ''}" 
                                id="perf-btn-clickthrough" 
                                title="Toggle Click-Through Mode (Interact with app underneath)" 
                                aria-label="Toggle Click-Through">
                            <svg viewBox="0 0 24 24"><path d="M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74c1.21-.81 2-2.18 2-3.74C16 5.01 13.99 3 11.5 3S7 5.01 7 7.5c0 1.56.79 2.93 2 3.74zm9.84 4.63l-4.54-2.26c-.17-.09-.35-.14-.54-.14H13v-6c0-.83-.67-1.5-1.5-1.5S10 6.67 10 7.5v10.74l-3.44-.72c-.09-.02-.17-.02-.26-.02-.37 0-.71.15-.96.39l-.83.84 5.34 5.34c.33.33.78.53 1.25.53h7.13c.87 0 1.57-.65 1.68-1.51l.73-5.18c.13-.9-.4-1.74-1.2-2.04z"/></svg>
                        </button>
                        <!-- Reset Metrics -->
                        <button type="button" class="perf-btn-icon" id="perf-btn-reset" title="Reset Statistics" aria-label="Reset Statistics">
                            <svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                        </button>
                        <!-- Upload Performance Audit Report to Server -->
                        <button type="button" class="perf-btn-icon" id="perf-btn-upload-report" title="Upload Performance Report to Server" aria-label="Upload Performance Report">
                            <svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
                        </button>
                        <!-- Minimize to Pill -->
                        <button type="button" class="perf-btn-icon" id="perf-btn-minimize" title="Minimize to Compact Pill" aria-label="Minimize to Compact Pill">
                            <svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
                        </button>
                        <!-- Close and Dismiss -->
                        <button type="button" class="perf-btn-icon" id="perf-btn-close" title="Close Diagnostics" aria-label="Close Diagnostics">
                            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                        </button>
                    </div>
                </div>

                <!-- Navigation Tabs -->
                <div class="perf-hud-nav">
                    <button type="button" class="perf-tab-btn ${this._activeTab === 'fps' ? 'active' : ''}" data-tab="fps">Framerate & Graph</button>
                    <button type="button" class="perf-tab-btn ${this._activeTab === 'vitals' ? 'active' : ''}" data-tab="vitals">Web Vitals (LCP)</button>
                    <button type="button" class="perf-tab-btn ${this._activeTab === 'system' ? 'active' : ''}" data-tab="system">System & Memory</button>
                </div>

                <!-- Scrollable Body Container -->
                <div class="perf-hud-body">
                    <!-- TAB 1: FRAMERATE & REALTIME GRAPH -->
                    <div id="perf-tab-content-fps" style="${this._activeTab === 'fps' ? '' : 'display: none;'}">
                        <!-- Hero Section: Current FPS and Frametime -->
                        <div class="perf-hero-section">
                            <div class="perf-hero-fps-box">
                                <span class="perf-hero-fps-val" id="perf-val-cur-fps">--</span>
                                <span class="perf-hero-fps-unit">FPS</span>
                            </div>
                            <div class="perf-hero-frametime">
                                <div class="perf-hero-frametime-val" id="perf-val-cur-ms">-- ms</div>
                                <div class="perf-hero-frametime-label">Frame Time</div>
                            </div>
                        </div>

                        <!-- 4-Stat Metric Card Grid -->
                        <div class="perf-stats-grid" style="margin-top: 10px;">
                            <div class="perf-stat-card">
                                <span class="perf-stat-label">Min / 1%</span>
                                <span class="perf-stat-val" id="perf-val-min-fps">--</span>
                            </div>
                            <div class="perf-stat-card">
                                <span class="perf-stat-label">Average</span>
                                <span class="perf-stat-val" id="perf-val-avg-fps">--</span>
                            </div>
                            <div class="perf-stat-card">
                                <span class="perf-stat-label">Highest</span>
                                <span class="perf-stat-val" id="perf-val-max-fps">--</span>
                            </div>
                            <div class="perf-stat-card">
                                <span class="perf-stat-label">Jank Stutters</span>
                                <span class="perf-stat-val" id="perf-val-jank-count">0</span>
                            </div>
                        </div>

                        <!-- Real-time Canvas Graph -->
                        <div class="perf-graph-container" style="margin-top: 10px;">
                            <div class="perf-graph-header">
                                <span>FRAME TIME HISTORY</span>
                                <span id="perf-graph-target-label">Target: 16.6ms (60 FPS)</span>
                            </div>
                            <canvas class="perf-graph-canvas" id="perf-graph-canvas"></canvas>
                        </div>
                    </div>

                    <!-- TAB 2: WEB VITALS & PAGE LOAD AUDIT -->
                    <div id="perf-tab-content-vitals" style="${this._activeTab === 'vitals' ? '' : 'display: none;'}">
                        <div class="perf-vitals-list">
                            <!-- Largest Contentful Paint (LCP) -->
                            <div class="perf-vital-card">
                                <div class="perf-vital-header">
                                    <div class="perf-vital-name-group">
                                        <span class="perf-vital-acronym">LCP</span>
                                        <span class="perf-vital-title">Largest Contentful Paint</span>
                                    </div>
                                    <span class="perf-vital-badge perf-badge-waiting" id="perf-badge-lcp">WAITING</span>
                                </div>
                                <div class="perf-vital-metric-row">
                                    <span class="perf-vital-value" id="perf-val-lcp">-- ms</span>
                                    <span class="perf-vital-target">Good: &lt; 2500ms</span>
                                </div>
                                <div class="perf-vital-element-box" id="perf-el-lcp" title="Target Element">
                                    Element: Assessing page DOM...
                                </div>
                            </div>

                            <!-- First Contentful Paint (FCP) -->
                            <div class="perf-vital-card">
                                <div class="perf-vital-header">
                                    <div class="perf-vital-name-group">
                                        <span class="perf-vital-acronym">FCP</span>
                                        <span class="perf-vital-title">First Contentful Paint</span>
                                    </div>
                                    <span class="perf-vital-badge perf-badge-waiting" id="perf-badge-fcp">WAITING</span>
                                </div>
                                <div class="perf-vital-metric-row">
                                    <span class="perf-vital-value" id="perf-val-fcp">-- ms</span>
                                    <span class="perf-vital-target">Good: &lt; 1800ms</span>
                                </div>
                            </div>

                            <!-- Cumulative Layout Shift (CLS) -->
                            <div class="perf-vital-card">
                                <div class="perf-vital-header">
                                    <div class="perf-vital-name-group">
                                        <span class="perf-vital-acronym">CLS</span>
                                        <span class="perf-vital-title">Cumulative Layout Shift</span>
                                    </div>
                                    <span class="perf-vital-badge perf-badge-waiting" id="perf-badge-cls">WAITING</span>
                                </div>
                                <div class="perf-vital-metric-row">
                                    <span class="perf-vital-value" id="perf-val-cls">0.000</span>
                                    <span class="perf-vital-target">Good: &lt; 0.100</span>
                                </div>
                            </div>

                            <!-- Interaction to Next Paint (INP) / First Input Delay (FID) -->
                            <div class="perf-vital-card">
                                <div class="perf-vital-header">
                                    <div class="perf-vital-name-group">
                                        <span class="perf-vital-acronym">INP / FID</span>
                                        <span class="perf-vital-title">Interaction Latency</span>
                                    </div>
                                    <span class="perf-vital-badge perf-badge-waiting" id="perf-badge-inp">WAITING</span>
                                </div>
                                <div class="perf-vital-metric-row">
                                    <span class="perf-vital-value" id="perf-val-inp">-- ms</span>
                                    <span class="perf-vital-target">Good: &lt; 200ms</span>
                                </div>
                            </div>

                            <!-- Time to First Byte (TTFB) -->
                            <div class="perf-vital-card">
                                <div class="perf-vital-header">
                                    <div class="perf-vital-name-group">
                                        <span class="perf-vital-acronym">TTFB</span>
                                        <span class="perf-vital-title">Time to First Byte</span>
                                    </div>
                                    <span class="perf-vital-badge perf-badge-waiting" id="perf-badge-ttfb">WAITING</span>
                                </div>
                                <div class="perf-vital-metric-row">
                                    <span class="perf-vital-value" id="perf-val-ttfb">-- ms</span>
                                    <span class="perf-vital-target">Good: &lt; 800ms</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- TAB 3: SYSTEM, MEMORY & ENVIRONMENT -->
                    <div id="perf-tab-content-system" style="${this._activeTab === 'system' ? '' : 'display: none;'}">
                        <div class="perf-system-list">
                            <!-- Memory Heap Usage -->
                            <div class="perf-system-row" style="flex-direction: column; align-items: stretch; gap: 4px;">
                                <div style="display: flex; justify-content: space-between;">
                                    <span class="perf-system-label">JS Heap Allocated</span>
                                    <span class="perf-system-val" id="perf-val-memory">Checking...</span>
                                </div>
                                <div class="perf-memory-bar-track">
                                    <div class="perf-memory-bar-fill" id="perf-bar-memory" style="width: 0%;"></div>
                                </div>
                            </div>

                            <!-- DOM Complexity -->
                            <div class="perf-system-row">
                                <span class="perf-system-label">Total Live DOM Nodes</span>
                                <span class="perf-system-val" id="perf-val-dom-nodes">--</span>
                            </div>

                            <!-- Active Route -->
                            <div class="perf-system-row">
                                <span class="perf-system-label">Active Route</span>
                                <span class="perf-system-val" id="perf-val-route">/</span>
                            </div>

                            <!-- Display Resolution & DPR -->
                            <div class="perf-system-row">
                                <span class="perf-system-label">Viewport & Screen</span>
                                <span class="perf-system-val" id="perf-val-viewport">--</span>
                            </div>

                            <!-- Platform & Runtime Engine -->
                            <div class="perf-system-row">
                                <span class="perf-system-label">Platform Target</span>
                                <span class="perf-system-val" id="perf-val-platform">--</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Finds and caches the graph canvas and 2D context.
     * @private
     */
    _bindCanvas() {
        this._canvas = this._container ? this._container.querySelector('#perf-graph-canvas') : null;
        if (this._canvas) {
            this._ctx = this._canvas.getContext('2d');
        }
    }

    /**
     * Binds mouse, touch drag handles, keyboard navigation, and centralized
     * delegated click listeners across all diagnostic overlay controls.
     * @private
     */
    _bindEvents() {
        if (!this._container) return;

        // Initialize drag interaction handlers for header and compact badge
        this._setupDraggable();

        /**
         * Delegated click dispatcher handling all overlay controls deterministically.
         * Resolves targets with closest() matching to support nested SVG icons.
         * @param {MouseEvent} e Click event
         */
        const onContainerClick = (e) => {
            const target = e.target;
            if (!target) return;

            // 1. Close overlay button
            const closeBtn = target.closest('#perf-btn-close');
            if (closeBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.hide();
                storage.setItem('debug_perf_overlay_enabled', false);

                // Synchronize with any active settings toggle
                const settingToggle = document.querySelector('#toggle-debug-perf-overlay');
                if (settingToggle) {
                    settingToggle.classList.remove('active');
                }
                return;
            }

            // 2. Minimize to compact pill button
            const minBtn = target.closest('#perf-btn-minimize');
            if (minBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.setMode('compact');
                return;
            }

            // 3. Expand from pill to full HUD button
            const expandBtn = target.closest('#perf-btn-expand');
            if (expandBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.setMode('full');
                return;
            }

            // 4. Reset telemetry statistics button
            const resetBtn = target.closest('#perf-btn-reset');
            if (resetBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.resetMetrics();
                return;
            }

            // 5. Upload performance report to server button
            const uploadBtn = target.closest('#perf-btn-upload-report');
            if (uploadBtn) {
                e.preventDefault();
                e.stopPropagation();
                uploadBtn.style.opacity = '0.5';
                import('./PerformanceReportCollector.js')
                    .then(({ performanceReportCollector }) => performanceReportCollector.uploadReport())
                    .then(() => {
                        uploadBtn.style.opacity = '1';
                        uploadBtn.classList.add('active');
                        setTimeout(() => uploadBtn.classList.remove('active'), 2500);
                    })
                    .catch(() => {
                        uploadBtn.style.opacity = '1';
                    });
                return;
            }

            // 6. Toggle click-through mode button
            const clickthroughBtn = target.closest('#perf-btn-clickthrough');
            if (clickthroughBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.toggleClickThrough();
                return;
            }

            // 6. Navigation tab buttons
            const tabBtn = target.closest('.perf-tab-btn');
            if (tabBtn) {
                e.preventDefault();
                e.stopPropagation();
                const tab = tabBtn.dataset.tab;
                if (tab) {
                    this.setActiveTab(tab);
                }
                return;
            }

            // 7. Click on compact pill body (expand to full if not dragged)
            if (this._mode === 'compact') {
                const pill = target.closest('#perf-pill-root');
                if (pill) {
                    // Ignore synthetic click triggered right after drag completion
                    if (this._justDragged) {
                        this._justDragged = false;
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    this.setMode('full');
                    return;
                }
            }
        };

        // Attach delegated click listener to root container
        this._container.addEventListener('click', onContainerClick);
        this._listeners.push({ element: this._container, event: 'click', handler: onContainerClick });

        /**
         * Keyboard event handler for TV remote and accessibility navigation.
         * Enables Enter/Space activation on focused interactive pill.
         * @param {KeyboardEvent} e Keydown event
         */
        const onContainerKeyDown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                const target = e.target;
                if (target && target.id === 'perf-pill-root' && this._mode === 'compact') {
                    e.preventDefault();
                    this.setMode('full');
                }
            }
        };

        this._container.addEventListener('keydown', onContainerKeyDown);
        this._listeners.push({ element: this._container, event: 'keydown', handler: onContainerKeyDown });
    }

    /**
     * Resolves the active root display scaling / CSS zoom factor.
     * Accounts for Litefin's responsive auto-fit 1080p canvas engine on desktop,
     * mobile webviews, and television framebuffer scaling.
     * @private
     * @returns {number} Active zoom ratio (e.g. 0.67 for 1080p auto-fit in 720p window)
     */
    _getEffectiveZoom() {
        if (typeof document === 'undefined' || !document.documentElement) {
            return 1.0;
        }

        // Inline zoom property set directly on root element by LayoutManager
        const inlineZoom = parseFloat(document.documentElement.style.zoom);
        if (!isNaN(inlineZoom) && inlineZoom > 0) {
            return inlineZoom;
        }

        // Fall back to computed style zoom if available in current browser engine
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
            const computedZoom = parseFloat(window.getComputedStyle(document.documentElement).zoom);
            if (!isNaN(computedZoom) && computedZoom > 0) {
                return computedZoom;
            }
        }

        return 1.0;
    }

    /**
     * Re-clamps custom coordinates within current viewport boundaries.
     * Called during window resizing or mode expansion to keep HUD within view.
     * @private
     */
    _reconstrainPosition() {
        if (!this._dragCoord || !this._container) return;

        // Resolve display scale factor
        const zoom = this._getEffectiveZoom();

        // Calculate virtual viewport dimensions matching the scaled canvas
        const viewportW = (window.innerWidth || 1920) / zoom;
        const viewportH = (window.innerHeight || 1080) / zoom;
        const width = this._container.offsetWidth || (this._mode === 'compact' ? 220 : 380);
        const height = this._container.offsetHeight || (this._mode === 'compact' ? 36 : 240);

        // Safe margin in design canvas coordinates
        const marginX = 10 / zoom;
        const marginY = 10 / zoom;

        // Clamp stored coordinate within safe bounds
        const x = Math.max(marginX, Math.min(this._dragCoord.x, viewportW - width - marginX));
        const y = Math.max(marginY, Math.min(this._dragCoord.y, viewportH - height - marginY));

        this._dragCoord = { x, y };
        this._container.style.left = `${x}px`;
        this._container.style.top = `${y}px`;
        this._container.style.right = 'auto';
        this._container.style.bottom = 'auto';
    }

    /**
     * Enables pointer and touch dragging for repositioning the HUD or pill.
     * Fully compensates for root CSS zoom and responsive auto-fit 1080p scaling,
     * allowing the overlay to smoothly track the cursor and reach all viewport edges.
     * @private
     */
    _setupDraggable() {
        let isPointerDown = false;
        let dragThresholdPassed = false;
        let startX = 0;
        let startY = 0;

        /**
         * Pointer down handler: identifies valid drag handles and records coords.
         * @param {MouseEvent|TouchEvent} e Pointer or touch down event
         */
        const onPointerDown = (e) => {
            // Ignore events originating directly on interactive buttons or tabs
            if (e.target && e.target.closest('button, .perf-btn-icon, .perf-pill-expand-btn, .perf-tab-btn')) {
                return;
            }

            // Verify event target falls within valid drag handles
            const isHeader = Boolean(e.target && e.target.closest('#perf-hud-header'));
            const isPill = Boolean(e.target && e.target.closest('#perf-pill-root'));
            if (!isHeader && !isPill) return;

            // Track initial pointer coordinates
            isPointerDown = true;
            dragThresholdPassed = false;
            this._justDragged = false;

            const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
            const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);

            startX = clientX;
            startY = clientY;

            // Account for display zoom scaling when computing grab offset within container
            const zoom = this._getEffectiveZoom();
            const rect = this._container.getBoundingClientRect();
            const pointerCanvasX = clientX / zoom;
            const pointerCanvasY = clientY / zoom;
            const containerCanvasLeft = rect.left / zoom;
            const containerCanvasTop = rect.top / zoom;

            this._dragOffset = {
                x: pointerCanvasX - containerCanvasLeft,
                y: pointerCanvasY - containerCanvasTop
            };

            // Note: We deliberately avoid calling preventDefault() here to allow
            // native click events to fire when the user merely clicks without dragging.
        };

        /**
         * Pointer move handler: repositions container once threshold is exceeded.
         * Scales motion and viewport boundary clamps by the active root zoom factor.
         * @param {MouseEvent|TouchEvent} e Pointer or touch move event
         */
        const onPointerMove = (e) => {
            if (!isPointerDown) return;

            const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
            const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);

            // Require 5px movement in physical screen pixels before engaging drag state
            if (!dragThresholdPassed) {
                const distance = Math.hypot(clientX - startX, clientY - startY);
                if (distance > 5) {
                    dragThresholdPassed = true;
                    this._isDragging = true;
                    if (this._container) {
                        this._container.setAttribute('data-dragged', 'true');
                    }
                } else {
                    return;
                }
            }

            // Prevent window scrolling while actively dragging HUD
            if (e.preventDefault && e.cancelable) {
                e.preventDefault();
            }

            // Compute virtual viewport dimensions in scaled canvas coordinates
            const zoom = this._getEffectiveZoom();
            const viewportW = (window.innerWidth || 1920) / zoom;
            const viewportH = (window.innerHeight || 1080) / zoom;
            const width = this._container.offsetWidth;
            const height = this._container.offsetHeight;

            // Convert pointer position into design canvas coordinate space
            const pointerCanvasX = clientX / zoom;
            const pointerCanvasY = clientY / zoom;

            let newX = pointerCanvasX - this._dragOffset.x;
            let newY = pointerCanvasY - this._dragOffset.y;

            // Safe boundary margin calibrated to physical viewport padding
            const marginX = 10 / zoom;
            const marginY = 10 / zoom;

            newX = Math.max(marginX, Math.min(newX, viewportW - width - marginX));
            newY = Math.max(marginY, Math.min(newY, viewportH - height - marginY));

            this._container.style.left = `${newX}px`;
            this._container.style.top = `${newY}px`;
            this._container.style.right = 'auto';
            this._container.style.bottom = 'auto';

            this._dragCoord = { x: newX, y: newY };
        };

        /**
         * Pointer up handler: releases drag state and handles synthetic click guard.
         */
        const onPointerUp = () => {
            if (!isPointerDown) return;
            isPointerDown = false;

            if (dragThresholdPassed) {
                this._isDragging = false;
                if (this._container) {
                    this._container.removeAttribute('data-dragged');
                }

                // Suppress immediate trailing click event following a drag operation
                this._justDragged = true;
                setTimeout(() => {
                    this._justDragged = false;
                }, 100);
            }

            dragThresholdPassed = false;
        };

        // Window resize listener to re-clamp custom positions if viewport size changes
        const onResize = () => {
            if (this._dragCoord && this._container) {
                this._reconstrainPosition();
            }
        };

        // Attach global move/up/resize handlers on window for smooth off-element dragging
        window.addEventListener('mousemove', onPointerMove, { passive: false });
        window.addEventListener('mouseup', onPointerUp, { passive: true });
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp, { passive: true });
        window.addEventListener('resize', onResize, { passive: true });

        this._listeners.push(
            { element: window, event: 'mousemove', handler: onPointerMove },
            { element: window, event: 'mouseup', handler: onPointerUp },
            { element: window, event: 'touchmove', handler: onPointerMove },
            { element: window, event: 'touchend', handler: onPointerUp },
            { element: window, event: 'resize', handler: onResize }
        );

        // Attach pointerdown listeners directly to the container
        this._container.addEventListener('mousedown', onPointerDown);
        this._container.addEventListener('touchstart', onPointerDown, { passive: true });

        this._listeners.push(
            { element: this._container, event: 'mousedown', handler: onPointerDown },
            { element: this._container, event: 'touchstart', handler: onPointerDown }
        );
    }

    /**
     * Primary animation frame processing loop measuring frame durations.
     * @private
     * @param {number} now High-resolution timestamp from requestAnimationFrame
     */
    _onAnimationFrame(now) {
        if (!this._isVisible) return;

        // Schedule next tick
        this._rafId = requestFrame((timestamp) => this._onAnimationFrame(timestamp));

        // Calculate interval since previous frame
        const delta = now - this._lastFrameTime;
        this._lastFrameTime = now;

        // Discard anomalies (e.g. background tab dormancy or OS sleep resumption)
        if (delta > 0 && delta < 500) {
            this._frameTimes.push(delta);
            if (this._frameTimes.length > this._maxHistorySamples) {
                this._frameTimes.shift();
            }

            this._sessionFrames++;
            this._sessionDurationMs += delta;

            // Instantaneous frame rate
            const instantFps = 1000 / delta;

            // Filter out transient boot spikes when updating extremes
            if (this._sessionFrames > 15) {
                if (instantFps > this._maxFps) {
                    this._maxFps = Math.min(360, Math.round(instantFps));
                }
                if (instantFps < this._minFps) {
                    this._minFps = Math.max(1, Math.round(instantFps));
                }
            }

            // Detect dropped frame or jank stutter (> 26ms represents drop below ~38 FPS)
            if (delta > 26) {
                this._jankCount++;
            }
        }

        // Render live canvas graph if on FPS tab in full mode
        // Throttled to every 3 frames (~20 FPS) to eliminate canvas layout and draw overhead on Smart TV hardware
        if (this._mode === 'full' && this._activeTab === 'fps' && this._sessionFrames % 3 === 0) {
            this._renderGraph();
        }
    }

    /**
     * Renders smooth anti-aliased frame time history curve on HTML5 canvas.
     * Uses box metrics instead of getBoundingClientRect() to avoid layout flushes,
     * and compiles data in a single clean path.
     * @private
     */
    _renderGraph() {
        if (!this._canvas || !this._ctx) return;

        const canvas = this._canvas;
        const ctx = this._ctx;

        // Query element client dimensions to avoid forced synchronous layout recalculation
        const dpr = window.devicePixelRatio || 1;
        const displayWidth = canvas.clientWidth || (canvas.offsetWidth ? Math.round(canvas.offsetWidth) : 320);
        const displayHeight = canvas.clientHeight || (canvas.offsetHeight ? Math.round(canvas.offsetHeight) : 72);

        if (displayWidth === 0 || displayHeight === 0) return;

        // Adjust internal buffer size to match physical display pixels for crisp lines
        const targetWidth = displayWidth * dpr;
        const targetHeight = displayHeight * dpr;
        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
            canvas.width = targetWidth;
            canvas.height = targetHeight;
        }

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, displayWidth, displayHeight);

        const w = displayWidth;
        const h = displayHeight;

        // Baseline reference lines
        // 16.6ms line (60 FPS) and 33.3ms line (30 FPS)
        // Scaled against maximum visible frame time of 50ms
        const maxTimeMs = 50;
        const y60 = h - (16.6 / maxTimeMs) * h;
        const y30 = h - (33.3 / maxTimeMs) * h;

        // Draw 60 FPS reference guideline
        ctx.strokeStyle = 'rgba(48, 209, 88, 0.25)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y60);
        ctx.lineTo(w, y60);
        ctx.stroke();

        // Draw 30 FPS reference guideline
        ctx.strokeStyle = 'rgba(255, 69, 58, 0.25)';
        ctx.beginPath();
        ctx.moveTo(0, y30);
        ctx.lineTo(w, y30);
        ctx.stroke();
        ctx.setLineDash([]);

        // Render data curve if samples exist
        const samples = this._frameTimes;
        if (samples.length > 1) {
            const step = w / (this._maxHistorySamples - 1);
            const startOffset = w - (samples.length - 1) * step;

            // Build single-pass frame duration curve
            ctx.beginPath();
            const prevX = startOffset;
            const prevY = h - Math.min(1, samples[0] / maxTimeMs) * h;
            ctx.moveTo(prevX, prevY);

            for (let i = 1; i < samples.length; i++) {
                const x = startOffset + i * step;
                const clamped = Math.min(maxTimeMs, Math.max(0, samples[i]));
                const y = h - (clamped / maxTimeMs) * h;
                ctx.lineTo(x, y);
            }

            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#30d158';
            ctx.stroke();

            // Highlight dropped frames and jank spikes with flat pixel markers
            ctx.fillStyle = '#ff453a';
            for (let i = 0; i < samples.length; i++) {
                if (samples[i] > 30) {
                    const x = startOffset + i * step;
                    const y = h - (Math.min(maxTimeMs, samples[i]) / maxTimeMs) * h;
                    ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
                }
            }
        }

        ctx.restore();
    }

    /**
     * Throttled routine computing numerical averages and writing to DOM elements.
     * @private
     */
    _updateMetricsDisplay() {
        if (!this._isVisible || !this._container) return;

        // Compute rolling averages from recent frame slice
        const recentSamples = this._frameTimes.slice(-20);
        if (recentSamples.length > 0) {
            const sum = recentSamples.reduce((acc, v) => acc + v, 0);
            const avgDelta = sum / recentSamples.length;
            this._currentFrameTimeMs = avgDelta;
            this._currentFps = Math.max(1, Math.min(360, Math.round(1000 / avgDelta)));

            // Detect target display refresh rate
            if (this._currentFps > 100) {
                this._detectedRefreshRate = 120;
            } else if (this._currentFps > 70) {
                this._detectedRefreshRate = 90;
            } else {
                this._detectedRefreshRate = 60;
            }
        }

        // Calculate overall average FPS across current monitoring session
        if (this._sessionDurationMs > 0) {
            this._avgFps = Math.round((this._sessionFrames / this._sessionDurationMs) * 1000);
        }

        // Calculate 1% Low frame rate: sort worst 1% of frame times
        if (this._frameTimes.length >= 20) {
            const sortedTimes = [...this._frameTimes].sort((a, b) => b - a); // Slowest first
            const onePercentCount = Math.max(1, Math.floor(sortedTimes.length * 0.05)); // 5% sample floor
            const worstTimes = sortedTimes.slice(0, onePercentCount);
            const avgWorstMs = worstTimes.reduce((acc, v) => acc + v, 0) / worstTimes.length;
            this._onePercentLowFps = Math.max(1, Math.round(1000 / avgWorstMs));
        } else {
            this._onePercentLowFps = this._currentFps;
        }

        // If min FPS is still infinite, align with current
        if (this._minFps === Infinity) {
            this._minFps = this._currentFps;
        }

        // Update active layout mode
        if (this._mode === 'compact') {
            this._updateCompactPillDisplay();
        } else {
            this._updateFullHudDisplay();
        }
    }

    /**
     * Updates text nodes inside the compact pill badge.
     * @private
     */
    _updateCompactPillDisplay() {
        const pillFps = this._container.querySelector('#perf-pill-fps');
        const pillLcp = this._container.querySelector('#perf-pill-lcp');
        const pillMem = this._container.querySelector('#perf-pill-mem');
        const pillDot = this._container.querySelector('#perf-pill-dot');

        if (pillFps) {
            pillFps.textContent = this._currentFps;
            // Apply status color classes
            pillFps.className = 'perf-pill-val ' + this._getFpsStatusClass(this._currentFps);
        }

        if (pillDot) {
            // Flat status indicator color without compositing box shadows
            if (this._currentFps < 30) {
                pillDot.style.backgroundColor = '#ff453a';
            } else if (this._currentFps < 50) {
                pillDot.style.backgroundColor = '#ffd60a';
            } else {
                pillDot.style.backgroundColor = '#30d158';
            }
        }

        if (pillLcp) {
            pillLcp.textContent = this._vitals.lcp !== null ? `${this._vitals.lcp}ms` : '--';
        }

        if (pillMem) {
            const mem = this._getMemoryStats();
            pillMem.textContent = mem ? mem.usedMb : '--';
        }
    }

    /**
     * Updates text nodes and status badges across the full HUD tabs.
     * @private
     */
    _updateFullHudDisplay() {
        // Refresh rate badge
        const hzBadge = this._container.querySelector('#perf-hz-badge');
        if (hzBadge) {
            hzBadge.textContent = `${this._detectedRefreshRate}Hz`;
        }

        // Target label on graph
        const targetLabel = this._container.querySelector('#perf-graph-target-label');
        if (targetLabel) {
            const targetMs = (1000 / this._detectedRefreshRate).toFixed(1);
            targetLabel.textContent = `Target: ${targetMs}ms (${this._detectedRefreshRate} FPS)`;
        }

        // Tab 1: Framerate Hero & Grid
        const curFpsEl = this._container.querySelector('#perf-val-cur-fps');
        const curMsEl = this._container.querySelector('#perf-val-cur-ms');
        const minFpsEl = this._container.querySelector('#perf-val-min-fps');
        const avgFpsEl = this._container.querySelector('#perf-val-avg-fps');
        const maxFpsEl = this._container.querySelector('#perf-val-max-fps');
        const jankEl = this._container.querySelector('#perf-val-jank-count');

        if (curFpsEl) {
            curFpsEl.textContent = this._currentFps;
            curFpsEl.className = 'perf-hero-fps-val ' + this._getFpsStatusClass(this._currentFps);
        }
        if (curMsEl) {
            curMsEl.textContent = `${this._currentFrameTimeMs.toFixed(1)} ms`;
        }
        if (minFpsEl) {
            minFpsEl.textContent = `${this._onePercentLowFps} (${this._minFps})`;
            minFpsEl.className = 'perf-stat-val ' + this._getFpsStatusClass(this._onePercentLowFps);
        }
        if (avgFpsEl) {
            avgFpsEl.textContent = this._avgFps;
            avgFpsEl.className = 'perf-stat-val ' + this._getFpsStatusClass(this._avgFps);
        }
        if (maxFpsEl) {
            maxFpsEl.textContent = this._maxFps;
        }
        if (jankEl) {
            jankEl.textContent = this._jankCount;
            jankEl.className = 'perf-stat-val ' + (this._jankCount > 0 ? 'perf-val-warn' : 'perf-val-good');
        }

        // Tab 2: Web Vitals
        this._updateWebVitalCards();

        // Tab 3: System, Memory & Route
        this._updateSystemTab();
    }

    /**
     * Updates Web Vitals cards with formatted latency and quality badges.
     * @private
     */
    _updateWebVitalCards() {
        // LCP
        const valLcp = this._container.querySelector('#perf-val-lcp');
        const badgeLcp = this._container.querySelector('#perf-badge-lcp');
        const elLcp = this._container.querySelector('#perf-el-lcp');
        if (valLcp && this._vitals.lcp !== null) {
            valLcp.textContent = `${this._vitals.lcp} ms`;
            if (this._vitals.lcp <= 2500) {
                badgeLcp.textContent = 'GOOD';
                badgeLcp.className = 'perf-vital-badge perf-badge-good';
            } else if (this._vitals.lcp <= 4000) {
                badgeLcp.textContent = 'NEEDS WORK';
                badgeLcp.className = 'perf-vital-badge perf-badge-warn';
            } else {
                badgeLcp.textContent = 'POOR';
                badgeLcp.className = 'perf-vital-badge perf-badge-poor';
            }
        }
        if (elLcp && this._vitals.lcpElement) {
            elLcp.textContent = `Target Element: ${escapeHtml(this._vitals.lcpElement)}`;
        }

        // FCP
        const valFcp = this._container.querySelector('#perf-val-fcp');
        const badgeFcp = this._container.querySelector('#perf-badge-fcp');
        if (valFcp && this._vitals.fcp !== null) {
            valFcp.textContent = `${this._vitals.fcp} ms`;
            if (this._vitals.fcp <= 1800) {
                badgeFcp.textContent = 'GOOD';
                badgeFcp.className = 'perf-vital-badge perf-badge-good';
            } else if (this._vitals.fcp <= 3000) {
                badgeFcp.textContent = 'NEEDS WORK';
                badgeFcp.className = 'perf-vital-badge perf-badge-warn';
            } else {
                badgeFcp.textContent = 'POOR';
                badgeFcp.className = 'perf-vital-badge perf-badge-poor';
            }
        }

        // CLS
        const valCls = this._container.querySelector('#perf-val-cls');
        const badgeCls = this._container.querySelector('#perf-badge-cls');
        if (valCls) {
            valCls.textContent = this._vitals.cls.toFixed(3);
            if (this._vitals.cls <= 0.1) {
                badgeCls.textContent = 'GOOD';
                badgeCls.className = 'perf-vital-badge perf-badge-good';
            } else if (this._vitals.cls <= 0.25) {
                badgeCls.textContent = 'NEEDS WORK';
                badgeCls.className = 'perf-vital-badge perf-badge-warn';
            } else {
                badgeCls.textContent = 'POOR';
                badgeCls.className = 'perf-vital-badge perf-badge-poor';
            }
        }

        // INP / FID
        const valInp = this._container.querySelector('#perf-val-inp');
        const badgeInp = this._container.querySelector('#perf-badge-inp');
        const inputLatency = this._vitals.inp !== null ? this._vitals.inp : this._vitals.fid;
        if (valInp && inputLatency !== null) {
            valInp.textContent = `${inputLatency} ms`;
            if (inputLatency <= 200) {
                badgeInp.textContent = 'GOOD';
                badgeInp.className = 'perf-vital-badge perf-badge-good';
            } else if (inputLatency <= 500) {
                badgeInp.textContent = 'NEEDS WORK';
                badgeInp.className = 'perf-vital-badge perf-badge-warn';
            } else {
                badgeInp.textContent = 'POOR';
                badgeInp.className = 'perf-vital-badge perf-badge-poor';
            }
        }

        // TTFB
        const valTtfb = this._container.querySelector('#perf-val-ttfb');
        const badgeTtfb = this._container.querySelector('#perf-badge-ttfb');
        if (valTtfb && this._vitals.ttfb !== null) {
            valTtfb.textContent = `${this._vitals.ttfb} ms`;
            if (this._vitals.ttfb <= 800) {
                badgeTtfb.textContent = 'GOOD';
                badgeTtfb.className = 'perf-vital-badge perf-badge-good';
            } else if (this._vitals.ttfb <= 1800) {
                badgeTtfb.textContent = 'NEEDS WORK';
                badgeTtfb.className = 'perf-vital-badge perf-badge-warn';
            } else {
                badgeTtfb.textContent = 'POOR';
                badgeTtfb.className = 'perf-vital-badge perf-badge-poor';
            }
        }
    }

    /**
     * Updates System & Memory tab rows with live telemetry.
     * @private
     */
    _updateSystemTab() {
        // Memory
        const valMem = this._container.querySelector('#perf-val-memory');
        const barMem = this._container.querySelector('#perf-bar-memory');
        const mem = this._getMemoryStats();
        if (mem) {
            if (valMem) {
                valMem.textContent = `${mem.usedMb} MB / ${mem.totalMb} MB (${mem.percent}%)`;
            }
            if (barMem) {
                barMem.style.width = `${mem.percent}%`;
            }
        } else {
            if (valMem) valMem.textContent = 'API Unavailable (Non-Chromium)';
            if (barMem) barMem.style.width = '0%';
        }

        // DOM node count
        const valDom = this._container.querySelector('#perf-val-dom-nodes');
        if (valDom) {
            const count = document.getElementsByTagName('*').length;
            valDom.textContent = count.toLocaleString();
            valDom.className = 'perf-system-val ' + (count > 2000 ? 'perf-val-poor' : count > 1200 ? 'perf-val-warn' : 'perf-val-good');
        }

        // Current active route
        const valRoute = this._container.querySelector('#perf-val-route');
        if (valRoute) {
            valRoute.textContent = router && typeof router.getCurrentPath === 'function' ? router.getCurrentPath() : window.location.hash || '/';
        }

        // Viewport and screen resolution (with active CSS zoom factor)
        const valView = this._container.querySelector('#perf-val-viewport');
        if (valView) {
            const dpr = (window.devicePixelRatio || 1).toFixed(2);
            const zoom = this._getEffectiveZoom();
            const zoomSuffix = zoom !== 1.0 ? ` | Zoom: ${zoom.toFixed(2)}x` : '';
            valView.textContent = `${window.innerWidth}×${window.innerHeight} (Screen: ${window.screen.width}×${window.screen.height} @ ${dpr}x${zoomSuffix})`;
        }

        // Platform target identifier
        const valPlatform = this._container.querySelector('#perf-val-platform');
        if (valPlatform) {
            const plat = platformInfo.isTizen ? 'Samsung Tizen TV' :
                         platformInfo.isWebOS ? 'LG webOS TV' :
                         platformInfo.isAndroid ? (platformInfo.isAndroidTv ? 'Android TV' : 'Android Mobile') :
                         platformInfo.isDesktop ? 'Tauri Desktop' : 'Web Browser';
            valPlatform.textContent = plat;
        }
    }

    /**
     * Helper resolving CSS status class for frame rates.
     * @private
     */
    _getFpsStatusClass(fps) {
        if (fps >= 55) return 'perf-val-good';
        if (fps >= 30) return 'perf-val-warn';
        return 'perf-val-poor';
    }

    /**
     * Resolves memory stats in megabytes from Chromium window.performance.memory.
     * @private
     */
    _getMemoryStats() {
        if (typeof window === 'undefined' || !window.performance || !window.performance.memory) {
            return null;
        }
        const mem = window.performance.memory;
        const used = Math.round(mem.usedJSHeapSize / (1024 * 1024));
        const total = Math.round(mem.totalJSHeapSize / (1024 * 1024));
        const limit = Math.round(mem.jsHeapSizeLimit / (1024 * 1024));
        const percent = Math.min(100, Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100));

        return {
            usedMb: used,
            totalMb: total,
            limitMb: limit,
            percent: percent
        };
    }
}

/**
 * Singleton instance of PerformanceDiagnosticOverlay.
 */
export const performanceOverlay = new PerformanceDiagnosticOverlay();
export default performanceOverlay;
