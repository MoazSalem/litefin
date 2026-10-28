/**
 * ============================================================================
 * Litefin Tizen - ScrollController
 * ============================================================================
 * Handles all scroll animation and element-into-view positioning for the
 * FocusManager. Owns animation frame state and easing logic.
 *
 * Supports:
 *   - Smooth scrolling with easeOutQuad easing (vertical + horizontal)
 *   - Apple-style spring physics scrolling (opt-in via pref:scrollPhysics)
 *   - Animation retargeting (updating target mid-animation)
 *   - Row-based vertical alignment (media rows snap to top)
 *   - Horizontal card centering within row-items containers
 *   - Hero section special-case (always scroll to 0)
 *   - Tall-row fallback (element-level scroll-into-view)
 *   - Generic vertical scroll-into-view for grids/lists
 *   - Scroll container discovery (modals, filters, page-content)
 *
 * Extracted from FocusManager to separate animation/positioning from
 * focus coordination.
 * ============================================================================
 */

import { storage } from '../utils/StorageService.js';
import { eventBus } from '../core/EventBus.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import {
    createSpring,
    springStep,
    chaseStep,
    railStep,
    flingStep,
    normalizeScrollPhysics,
    SPRING_SUBSTEP_MS,
    SPRING_SETTLE_DISTANCE_PX,
    SPRING_SETTLE_VELOCITY_PX_MS,
    SPRING_MAX_DURATION_MS,
    SPRING_MIN_DURATION_MS,
    CHASE_TAU_FACTOR,
    RAIL_DECEL_ZONE_FRACTION,
    FLING_VELOCITY_MULTIPLIER,
    PHYSICS_SETTLE_DISTANCE_PX,
    GLIDE_ZONE_FRACTION,
    GLIDE_ZONE_MAX_PX,
    GLIDE_FALLBACK_SPEED_PX_MS,
    GLIDE_ENTRY_SPEED_CAP_PX_MS,
    GLIDE_MIN_DURATION_MS,
    getHorizontalDurationMs,
    NOMINAL_FRAME_MS,
    stableFrameDelta
} from './SpringPhysics.js';

// ============================================================================
// Constants — all tunable values in one place for easy TV hardware tweaking
// ============================================================================

/**
 * Resolves the base vertical scroll animation duration (in ms) based on user preference and platform:
 * - 'instant': 0ms (snaps immediately with no motion)
 * - 'current': Snappy platform default (130ms on desktop/web, 180ms on TV)
 * - 'smooth' (default): Balanced smoothness (200ms on desktop/web, 240ms on TV)
 * - 'slower': Relaxed, cinematic smooth (280ms on desktop/web, 340ms on TV)
 *
 * @returns {number} Duration in milliseconds
 */
function getBaseVerticalDuration() {
    // Defaults to 'smooth' for fluid vertical navigation motion
    const pref = storage.getItem('pref:scrollSmoothingDuration') || 'smooth';
    if (pref === 'instant') return 0;
    const isDesktop = platformInfo.isDesktop || platformInfo.isWeb;
    if (pref === 'slower') return isDesktop ? 280 : 340;
    if (pref === 'smooth') return isDesktop ? 200 : 240;
    return isDesktop ? 130 : 180;
}

// Minimum pixel difference to consider "not at target" (avoids sub-pixel jitter)
const SCROLL_SNAP_THRESHOLD = 1;

// Buffer (px) around viewport edges for row visibility cutoff detection.
// Used as a safety margin when bottom-aligning elements in tall rows.
const ROW_CUTOFF_BUFFER = 40;

// Default top offset (px) when aligning a row to the top of the viewport.
// Tuned to 40px to harmonize with .page-content's scroll-padding-top (40px)
// while providing optimal headroom so the preceding row's bottom card subtitles
// remain strictly off-screen above the viewport.
const DEFAULT_SCROLL_OFFSET_TOP = 40;

// Default bottom offset (px) when aligning a row to the bottom of the viewport.
// Tuned to 18px to hit the ideal visual balance:
// - Keeps the succeeding row's section title strictly off-screen below the viewport.
// - Gives the active row's card titles, subtitles, and years generous breathing room above the bottom screen edge.
// - Prevents top-edge clipping of the active row title on portrait and standard poster cards.
const DEFAULT_SCROLL_OFFSET_BOTTOM = 18;

// Threshold (px) — if the row's top is already within this distance of
// the ideal scroll position, skip scrolling. Prevents micro-jitter when
// navigating horizontally within the same row, but keep it small so
// vertical transitions always trigger a smooth scroll.
const SCROLL_ALIGN_THRESHOLD = 5;

// Buffer (px) around viewport edges for horizontal row visibility detection.
// Used when scrolling a parent row into view before centering a card.
const HORIZONTAL_ROW_VISIBILITY_BUFFER = 80;

// Comfort margins (px) for generic "scroll into view" in grids and lists.
// Ensures the focused element isn't flush against the viewport edge.
const GENERIC_SCROLL_MARGIN = 100;

// Height multiplier threshold: if a row is taller than viewport * this value,
// row-based alignment is disabled to prevent jarring jumps.
const TALL_ROW_MULTIPLIER = 2.0;

// Fraction of viewport height: if a single scroll delta exceeds this fraction,
// snap instantly instead of animating. Hero carousel ↔ row transitions on
// the home page produce 500-750px deltas that exceed the Tizen GPU's compositing
// budget — each intermediate frame must repaint the hero (Ken Burns animation,
// gradient overlays, backdrop layer) AND the content rows (per-row translateZ(0)
// compositor layers), causing visible frame drops. Instant-snapping large deltas
const LARGE_SCROLL_SNAP_FRACTION = 0.45;

// ============================================================================
// ADAPTIVE PHYSICS SAMPLING (webOS 3 / low-tier hardware)
// ============================================================================
// Physics engines are frame-rate normalized, but their *character* degrades
// when panel frame delivery is slow: the spring engine's crisp per-substep
// envelope turns into stutter when rAF intervals swing past ~24ms (webOS 3
// routinely drops to 30-40fps under image loads). While spring physics is
// active the controller measures rolling rAF intervals; a slow median flips
// the engine to CHASE, whose single-exponential update is inherently immune
// to frame jank (see chaseStep's stall-safety guarantee).
// ============================================================================

// Cap for a *calibrated* rAF interval sample. Samples past this are genuine
// stalls (tab hidden, GC pause) and would poison the median — reject them.
const ADAPTIVE_SAMPLE_REJECT_MAX_MS = 500;

// Rolling sample window (frames) for the median frame-interval measurement.
const ADAPTIVE_SAMPLE_WINDOW = 24;

// Minimum samples before degradation judgments are trusted (~0.4s of scroll).
const ADAPTIVE_MIN_SAMPLES = 6;

// Median rAF interval above which the panel is treated as frame-time starved.
// 24ms ≈ <40fps — the point where the spring's crispness visibly degrades.
const ADAPTIVE_FRAME_TARGET_MS = 24;

// All scroll physics engines recognized by getScrollPhysics() live in
// SpringPhysics.js (SCROLL_PHYSICS_ENGINES / normalizeScrollPhysics).

class ScrollController {
    constructor() {
        // ====================================================================
        // Animation state — separate for vertical and horizontal
        // Each stores { container, startScroll, target, startTime, duration }
        // ====================================================================
        this._verticalScrollState = null;
        this._horizontalScrollState = null;
        this._verticalScrollAnimationId = null;
        this._horizontalScrollAnimationId = null;

        // ====================================================================
        // NATIVE SCROLL ANIMATION STATE TRACKING
        // ====================================================================
        // Native container.scrollTo({ behavior: 'smooth' }) offloads the
        // scroll animation to the native browser rendering thread.
        // We track native scroll active state using a timer so isAnimating
        // returns true throughout native scrolling, preventing LazyLoader
        // from firing heavy image loads and DOM mutations mid-scroll.
        // ====================================================================
        this._nativeScrollActive = false;
        this._nativeScrollTimeout = null;
        // Track the current target coordinate of any active native smooth scroll.
        // Prevents re-invoking container.scrollTo({ behavior: 'smooth' }) with the
        // same target coordinate mid-scroll, which would retrigger the animation.
        this._nativeTargetScroll = null;

        // PERFORMANCE: offsetTop cache to prevent DOM reflows on every keypress.
        //
        // getCumulativeOffsetTop() walks the offsetParent chain — each step
        // reads .offsetTop and .offsetParent, both of which force a synchronous
        // layout recalculation (reflow) on Tizen's slow CPU.
        //
        // Since media rows don't move within the page, their offsetTop relative
        // to .page-content is stable between keypresses. We cache each row's
        // computed offset in a WeakMap keyed by the row element itself.
        //
        // The cache is cleared on page navigation (resetCache) or when the
        // scroll container changes.
        // ====================================================================
        this._offsetCache = new WeakMap();

        // Expose to window for lazy-load checking to bypass circular imports
        window.__scrollController = this;

        // --------------------------------------------------------------------
        // HORIZONTAL SCROLL MODE INITIALIZATION
        // --------------------------------------------------------------------
        // Stamps the initial data-horizontal-scroll attribute on <html>
        // and subscribes to runtime preference changes from SettingsPage.
        // --------------------------------------------------------------------
        this._applyHorizontalScrollMode(this.getHorizontalScrollMode());
        eventBus.on('pref:horizontalScrollMode', (mode) => {
            this._applyHorizontalScrollMode(mode);
        });

        // --------------------------------------------------------------------
        // SCROLL PHYSICS INITIALIZATION
        // --------------------------------------------------------------------
        // Stamps the initial data-scroll-physics attribute on <html>. The
        // 'spring' value flips .row-items-track CSS transitions off — JS-driven
        // per-frame transform writes (the spring integrator) would otherwise
        // fight the CSS transition on every frame.
        // --------------------------------------------------------------------
        this._applyScrollPhysics(this.getScrollPhysics());
        eventBus.on('pref:scrollPhysics', (physics) => {
            // Reset both axis engines so an in-flight animation never
            // blends two different physics models.
            this.cancelAnimation('vertical');
            this.cancelAnimation('horizontal');
            this._applyScrollPhysics(physics === 'easing' ? 'easing' : physics);
        });

        // --------------------------------------------------------------------
        // ADAPTIVE FRAME SAMPLER
        // --------------------------------------------------------------------
        // Rolling log of recent rAF intervals (ms). Populated by the physics
        // loop every animated frame; decides whether the spring engine should
        // degrade to CHASE on frame-time-starved panels (webOS 3 et al).
        // --------------------------------------------------------------------
        this._frameSamples = [];
    }

    /**
     * Resolves the active vertical scroll animation mode from stored preferences.
     * Supported options:
     * - 'gpu': Fast hardware-accelerated CSS translate3d transforms on .vertical-scroll-track.
     * - 'native': Smooth animated scrolling via JS RAF scrollTop.
     * - 'current': Standard custom JS RAF loops.
     * - 'instant': Immediate position snapping without transition delay.
     *
     * @returns {'gpu'|'native'|'current'|'instant'} Active vertical scroll mode
     */
    getVerticalScrollMode() {
        // Retrieve explicit user preference from persistent local storage
        const stored = storage.getItem('pref:verticalScrollMode');
        if (stored) {
            return stored;
        }

        // Default to smooth native scrolling across all platforms
        // for unified, fluid, and predictable vertical viewport transitions.
        // Native mode ensures consistent scroll dynamics without compositor quirks.
        return 'native';
    }

    /**
     * Resolves the configured horizontal media row scroll animation mode from stored preferences.
     * Supported options:
     * - 'gpu': Fast hardware-accelerated CSS translate3d transitions directly on .row-items-track.
     * - 'native': Smooth animated scrolling via container.scrollLeft / smoothScrollTo.
     * - 'instant': Immediate snap to focused card without animation.
     *
     * @returns {'gpu'|'native'|'instant'} Active horizontal scroll mode
     */
    getHorizontalScrollMode() {
        // Retrieve explicit user preference from persistent local storage
        const stored = storage.getItem('pref:horizontalScrollMode');
        if (stored) {
            return stored;
        }

        /*
         * Default horizontal scrolling animation behavior:
         * - Defaults to 'native' (Smooth) across all platforms for unified,
         *   consistent, and fluid media row scrolling.
         */
        return 'native';
    }

    /**
     * ========================================================================
     * VERTICAL SCROLL FOCUS ALIGNMENT CONFIGURATION
     * ========================================================================
     * Resolves the target alignment mode when focusing rows or vertical list items.
     * Supported options:
     *   - 'bottom' (Default): Aligns focused rows toward the lower viewport boundary.
     *     This drastically minimizes scroll frequency, as rows already within view
     *     require zero scroll adjustments, eliminating unnecessary repaints and
     *     GPU compositor thrashing on Smart TV hardware.
     *   - 'middle': Centers the active row or item in the middle of the viewport.
     *   - 'top': Sticks the active row near the top of the viewport with top padding.
     *
     * @returns {'bottom'|'middle'|'top'} Active vertical scroll alignment mode
     * ========================================================================
     */
    getVerticalScrollAlignment() {
        // Read explicit user preference from persistent local storage
        const stored = storage.getItem('pref:verticalScrollAlignment');

        // Validate and normalize supported alignment keywords
        if (stored === 'top' || stored === 'middle' || stored === 'center' || stored === 'bottom') {
            return stored === 'center' ? 'middle' : stored;
        }

        // 'bottom' is the default behavior: it preserves viewport stability and
        // eliminates repetitive layout scrolling when navigating adjacent rows.
        return 'bottom';
    }

    /**
     * Stamped onto document.documentElement to control overflow behavior and
     * hardware-compositing rules in layout.css / android-mobile.css.
     *
     * @param {'gpu'|'native'|'instant'} mode
     * @private
     */
    _applyHorizontalScrollMode(mode) {
        if (typeof document?.documentElement?.setAttribute === 'function') {
            document.documentElement.setAttribute('data-horizontal-scroll', mode);
        }
    }

    /**
     * Resolves the active scroll physics engine from stored preferences via
     * the shared SpringPhysics normalizer (same rules as TouchHorizontalScroller
     * and the settings dropdown). Supported options:
     * - 'easing' (default): Classic time-based easeOutQuad curves.
     * - 'spring': Critically-damped velocity physics (Apple TV glide).
     * - 'chase': First-order exponential camera follower (continuous chase).
     * - 'rail': Constant-velocity travel with a linear deceleration tail.
     * - 'fling': Momentum sweep with friction-glide landing.
     *
     * @returns {'easing'|'spring'|'chase'|'rail'|'fling'} Active physics engine
     */
    getScrollPhysics() {
        return normalizeScrollPhysics(storage.getItem('pref:scrollPhysics'));
    }

    /**
     * Stamped onto document.documentElement so stylesheets can disable CSS
     * transition rules that would fight JS-driven physics transform writes.
     *
     * @param {'easing'|'spring'|'chase'|'rail'|'fling'} physics
     * @private
     */
    _applyScrollPhysics(physics) {
        if (typeof document?.documentElement?.setAttribute === 'function') {
            document.documentElement.setAttribute('data-scroll-physics', physics);
        }
    }

    /**
     * Records one raw rAF interval (ms) into the adaptive sampler.
     * @param {number} deltaMs
     * @private
     */
    _recordFrameDelta(deltaMs) {
        this._frameSamples.push(deltaMs);
        if (this._frameSamples.length > ADAPTIVE_SAMPLE_WINDOW) {
            this._frameSamples.shift();
        }
    }

    /**
     * Decides whether the panel's frame delivery is too slow for the spring
     * engine's crisp per-substep envelope. Uses the median of the rolling
     * rAF-interval sampler so single outliers never trigger the fallback.
     *
     * @returns {boolean} True when median frame time exceeds ADAPTIVE_FRAME_TARGET_MS
     * @private
     */
    _isFrameTimingDegraded() {
        const samples = this._frameSamples;
        if (samples.length < ADAPTIVE_MIN_SAMPLES) return false;
        const sorted = [...samples].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] > ADAPTIVE_FRAME_TARGET_MS;
    }

    /**
     * Resolves the physics engine to actually integrate with. The Apple TV
     * spring auto-degrades to CHASE when the frame sampler detects a slow
     * panel: a follower update is a single exponential, perfectly stable at
     * any frame interval, so jank reads as mild slowness instead of stutter.
     *
     * @returns {'spring'|'chase'|'rail'|'fling'}
     * @private
     */
    _resolvePhysicsEngine() {
        const pref = this.getScrollPhysics();
        if (pref === 'spring' && this._isFrameTimingDegraded()) {
            return 'chase';
        }
        return pref;
    }

    /**
     * Check if there are active scroll animations in progress across all axes.
     * @returns {boolean}
     */
    get isAnimating() {
        return (
            this._verticalScrollAnimationId !== null ||
            this._horizontalScrollAnimationId !== null ||
            this._nativeScrollActive === true
        );
    }

    /**
     * Check specifically if a vertical scroll animation is in flight (RAF or native).
     * Used by FocusManager to detect rapid keypresses arriving before the previous
     * vertical animation has settled, enabling instant snap without animation queuing.
     * @returns {boolean}
     */
    get isVerticalAnimating() {
        return this._verticalScrollAnimationId !== null || this._nativeScrollActive === true;
    }

    /**
     * Emit scroll:finished event if no scroll animation remains active
     * @private
     */
    _checkScrollFinished() {
        if (
            this._verticalScrollAnimationId === null &&
            this._horizontalScrollAnimationId === null &&
            !this._nativeScrollActive
        ) {
            eventBus.emit('scroll:finished');
        }
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * ========================================================================
     * OFFSET CACHE PRE-WARMING
     * ========================================================================
     * Batch-computes and caches the offsetTop for a list of elements relative
     * to a scroll container. Called once after a grid renders inside a single
     * requestAnimationFrame to ensure the styles are committed before we read.
     *
     * This eliminates the forced synchronous layout reflows that would otherwise
     * occur when getCumulativeOffsetTop() is called per D-pad keypress for
     * elements whose offsetParent chain resolves normally (not via transform).
     *
     * Elements inside CSS transform containers (e.g. .row-items-track) are NOT
     * safe to cache because their values are scroll-relative — we skip those
     * automatically by checking if the chain reaches the relativeTo container.
     *
     * @param {NodeList|Array} elements - Grid card elements to pre-warm
     * @param {HTMLElement} relativeTo - The scroll container (.page-content)
     */
    prewarmOffsetCache(elements, relativeTo) {
        if (!elements || !relativeTo) return;

        // Walk every element's offsetParent chain and store the cumulative top.
        // All reads are batched in this single call, so the browser only needs
        // one layout pass to satisfy all the offsetTop queries.
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];

            // -----------------------------------------------------------------
            // ROW ISOLATION GUARD: Static media rows only
            // -----------------------------------------------------------------
            // Dynamic grid cards, list items, or elements preceded by dynamic
            // spacers (such as #grid-top-spacer in LibraryPage) change their effective
            // offset when rows are prepended or evicted. Caching volatile cards
            // poisons the offset map with stale values that corrupt scroll targeting.
            // -----------------------------------------------------------------
            if (!el.classList.contains('media-row')) continue;

            // Skip if already cached (can happen on append/pagination)
            if (this._offsetCache.has(el)) continue;

            let top = 0;
            let current = el;

            // Walk offsetParent chain
            while (current && current !== relativeTo && current !== document.body) {
                top += current.offsetTop || 0;
                current = current.offsetParent;
            }

            // Only cache if the chain completed — elements inside transformed
            // containers will exit early and must NOT be cached (stale values).
            if (current === relativeTo) {
                this._offsetCache.set(el, { container: relativeTo, value: top });
            }
        }
    }

    /**
     * Smooth scroll with easeOutQuad easing and retarget support.
     *
     * Uses a time-based animation with proper easing curve.
     * If called again while an animation is in progress for the same
     * direction, the target is updated and timing resets from the
     * current position (retargeting), avoiding jarring jumps.
     *
     * @param {HTMLElement} container - The scrollable container element
     * @param {number} targetScroll - Target scroll position in px
     * @param {number} [duration=200] - Animation duration in ms
     * @param {'vertical'|'horizontal'} [direction='vertical'] - Scroll axis
     */
    /**
     * ========================================================================
     * VERTICAL SCROLL VALUE RETRIEVAL
     * ========================================================================
     * Resolves the current vertical scrolling position in pixels. Supports:
     *   - Standard native containers (using container.scrollTop).
     *   - GPU-accelerated transformed containers (using the vertical track style).
     *
     * @param {HTMLElement} container - The scrollable container element.
     * @returns {number} Current vertical scroll offset in px.
     * ========================================================================
     */
    getVerticalScroll(container) {
        if (!container) return 0;

        // Retrieve active vertical scroll style preference.
        const scrollMode = this.getVerticalScrollMode();

        // Check if GPU mode is active and parse the translate3d string coordinate.
        if (scrollMode === 'gpu') {
            const track = container.querySelector('.vertical-scroll-track');
            if (track) {
                const transform = track.style.transform || track.style.webkitTransform || '';
                // ============================================================
                // ROBUST TRANSLATE3D PARSING REGEX
                // ============================================================
                // TV browsers (such as older Tizen or WebOS models) often
                // normalize unit values in transform strings (e.g., converting
                // "0px" to "0"). The previous regex was hardcoded to "0px" and
                // failed to match normalized strings, resulting in scroll offset
                // read errors (returning 0) and poisoning offset caches.
                //
                // This updated regex matches:
                //   - translate3d(
                //   - First coordinate (X): optional sign, digits, optional px/%
                //   - Second coordinate (Y): captured sign and digits, optional px/%
                // ============================================================
                const match = transform.match(/translate3d\(\s*-?[\d.]+(?:px|%)?,\s*(-?[\d.]+)(?:px|%)?/);
                return match ? Math.abs(parseFloat(match[1])) : 0;
            }
        }

        return container.scrollTop;
    }

    /**
     * Smooth scroll with easeOutQuad easing and retarget support.
     *
     * Uses a time-based animation with proper easing curve.
     * If called again while an animation is in progress for the same
     * direction, the target is updated and timing resets from the
    /**
     * Resolves the current base vertical scroll animation duration (ms) based on user preference and platform.
     * @returns {number}
     */
    getVerticalScrollDuration() {
        return getBaseVerticalDuration();
    }

    /**
     * Resolves the horizontal (media-row) scroll animation duration (ms).
     * Honors the same 4-value scrollSmoothingDuration preference as vertical
     * navigation ('instant' | 'current' | 'smooth' | 'slower'), mapped to
     * proportionally quicker timings since row hops are shorter.
     * @returns {number}
     */
    getHorizontalScrollDuration() {
        const pref = storage.getItem('pref:scrollSmoothingDuration') || 'smooth';
        const isDesktop = platformInfo.isDesktop || platformInfo.isWeb;
        return getHorizontalDurationMs(pref, isDesktop);
    }

    /**
     * Smooth scroll with easeOutQuad easing and retarget support.
     *
     * Uses a time-based animation with proper easing curve.
     * If called again while an animation is in progress for the same
     * direction, the target is updated and timing resets from the
     * current position (retargeting), avoiding jarring jumps.
     *
     * @param {HTMLElement} container - The scrollable container element
     * @param {number} targetScroll - Target scroll position in px
     * @param {number|Function|null} [duration=null] - Animation duration in ms (resolves to getVerticalScrollDuration if null)
     * @param {'vertical'|'horizontal'} [direction='vertical'] - Scroll axis
     */
    smoothScrollTo(container, targetScroll, duration = null, direction = 'vertical') {
        const isVertical = direction === 'vertical';
        const stateKey = isVertical ? '_verticalScrollState' : '_horizontalScrollState';
        const animIdKey = isVertical ? '_verticalScrollAnimationId' : '_horizontalScrollAnimationId';

        // Resolve active scroll mode and duration preference from stored user preferences.
        const scrollMode = isVertical ? this.getVerticalScrollMode() : this.getHorizontalScrollMode();
        const durationPref = storage.getItem('pref:scrollSmoothingDuration') || 'smooth';

        /* ====================================================================
         * 🚀 INSTANT SCROLL NAVIGATION OVERRIDE
         * ====================================================================
         * Snaps content immediately without animation if verticalScrollMode,
         * horizontalScrollMode, or scrollSmoothingDuration is configured to 'instant'.
         * ==================================================================== */
        let durationToUse =
            duration !== null
                ? typeof duration === 'function'
                    ? duration()
                    : duration
                : isVertical
                  ? this.getVerticalScrollDuration()
                  : this.getHorizontalScrollDuration();
        if (scrollMode === 'instant' || durationPref === 'instant') {
            durationToUse = 0;
        }

        // Reset the vertical track's transform if we've switched away from GPU mode.
        if (!isVertical || scrollMode !== 'gpu') {
            const existingTrack = container.querySelector('.vertical-scroll-track');
            if (existingTrack && (existingTrack.style.transform || existingTrack.style.webkitTransform)) {
                existingTrack.style.transform = 'translate3d(0px, 0px, 0px)';
                existingTrack.style.webkitTransform = 'translate3d(0px, 0px, 0px)';
            }
        }

        // Initialize or retrieve the vertical scroll track in GPU mode.
        let track = null;
        if (isVertical && scrollMode === 'gpu') {
            track = container.querySelector('.vertical-scroll-track');
            if (!track) {
                // Wrap all direct children inside a hardware-accelerated wrapper container.
                track = document.createElement('div');
                track.className = 'vertical-scroll-track';
                while (container.firstChild) {
                    track.appendChild(container.firstChild);
                }
                container.appendChild(track);

                // Configure CSS layout rules to bypass composition reflows cleanly.
                container.style.overflow = 'hidden';
                track.style.width = '100%';
                track.style.height = 'auto';
                track.style.willChange = 'transform';
                container.scrollTop = 0;
            }
        }

        // Resolve current coordinates through our unified scroll reader.
        const currentScroll = isVertical ? this.getVerticalScroll(container) : container.scrollLeft;

        // ----------------------------------------------------------------
        // DYNAMIC VELOCITY ADAPTATION (Hero Carousel & Long Leaps)
        // ----------------------------------------------------------------
        // Standard row-to-row navigation (~350-450px) uses the snappy base duration
        // (130ms on desktop, 180ms on TV). Only massive transitions (e.g. hero carousel ↔
        // first content row at >550px) scale smoothly to prevent compositor hitching.
        // ----------------------------------------------------------------
        if (isVertical && durationToUse > 0) {
            // Measure the absolute travel distance across the vertical axis
            const distance = Math.abs(targetScroll - currentScroll);

            // True large vertical transitions (e.g. hero carousel ↔ content rows at >550px)
            if (distance > 550) {
                const minFloor = Math.round(durationToUse * 1.25);
                const maxCap = Math.round(durationToUse * 1.75);
                durationToUse = Math.min(
                    maxCap,
                    Math.max(minFloor, Math.round(durationToUse * (1 + (distance - 550) / 400)))
                );
            }
        }

        // STABILIZATION: Cleanly reset horizontal drift once at initialization
        // rather than reading layout on every animation frame.
        if (isVertical && container.scrollLeft !== 0) {
            container.scrollLeft = 0;
        }

        // Already at target or instant scroll requested — snap and bail.
        // CRITICAL: Cancel any running animation in this axis BEFORE snapping.
        if (durationToUse <= 0 || Math.abs(targetScroll - currentScroll) < SCROLL_SNAP_THRESHOLD) {
            // Cancel running RAF animation if active
            if (this[animIdKey]) {
                cancelAnimationFrame(this[animIdKey]);
                this[animIdKey] = null;
                this[stateKey] = null;
            }
            if (isVertical) {
                // Clear any active native scroll silence timer and reset tracking
                if (this._nativeScrollTimeout) {
                    clearTimeout(this._nativeScrollTimeout);
                    this._nativeScrollTimeout = null;
                }
                this._nativeScrollActive = false;
                this._nativeTargetScroll = null;

                // When native smooth scroll is active, direct scrollTop assignment does NOT
                // abort the browser's native smooth scroll engine per CSSOM View specs.
                // Invoking scrollTo with behavior: 'auto' cleanly terminates ongoing smooth
                // animations, eliminating compositor hitches and fighting layout locks.
                if (scrollMode === 'native' && typeof container.scrollTo === 'function') {
                    try {
                        container.scrollTo({ top: targetScroll, behavior: 'auto' });
                    } catch (_) {
                        container.scrollTop = targetScroll;
                    }
                } else if (scrollMode === 'gpu' && track) {
                    // Update transform coordinates on GPU compositor track.
                    // Snap compositor track directly to target scroll offset without visual jumps.
                    track.style.transform = `translate3d(0px, -${targetScroll}px, 0px)`;
                    track.style.webkitTransform = `translate3d(0px, -${targetScroll}px, 0px)`;
                    container.scrollTop = 0;
                } else {
                    container.scrollTop = targetScroll;
                }
                // STABILIZATION: Force reset of horizontal drift on vertical containers.
                if (container.scrollLeft !== 0) {
                    container.scrollLeft = 0;
                }
            } else {
                container.scrollLeft = targetScroll;
            }
            this._checkScrollFinished();
            return;
        }

        /* ====================================================================
         * 🍏 SCROLL PHYSICS ENGINES (OPT-IN)
         * ====================================================================
         * When pref:scrollPhysics is set, the hop is delegated to the
         * velocity-driven engine integrators (spring / chase / rail / fling)
         * instead of the time-based easing loop. Everything above this point
         * (instant snap, GPU track setup, dynamic duration scaling for long
         * leaps) applies identically to all engines.
         * ==================================================================== */
        if (this.getScrollPhysics() !== 'easing') {
            this._springScrollTo({
                stateKey,
                animIdKey,
                container,
                track,
                currentScroll,
                targetScroll,
                duration: durationToUse,
                isVertical,
                scrollMode
            });
            return;
        }

        /* ====================================================================
         * 🎬 UNIFIED SMOOTH SCROLL ANIMATION ENGINE (JS RAF + RETARGETING)
         * ====================================================================
         * Web browsers (Chromium on Samsung Tizen & LG webOS, WebKit, and Gecko)
         * implement Element.prototype.scrollTo({ behavior: 'smooth' }) with a
         * hardcoded cubic-bezier ease-in curve that ALWAYS initializes with zero
         * velocity. Crucially, per the W3C CSSOM View specification:
         *
         *   "If element has an ongoing smooth scroll, abort that smooth scroll."
         *
         * When a user holds UP or DOWN on a TV remote, key repeats fire every
         * 125ms. Calling container.scrollTo({ behavior: 'smooth' }) every 125ms
         * aborts the active scroll mid-flight after only 10-20px of travel, and
         * restarts a brand-new ease-in curve with v0 = 0.
         *
         * This traps the viewport in an endless ease-in stutter loop on the exact
         * same item, while D-pad focus advances far down the page.
         *
         * Both 'current' and 'native' modes therefore leverage Litefin's unified,
         * hardware-accelerated JS RAF animation loop below. Using an easeOutQuad
         * curve (maximum velocity at t=0, smoothly decelerating) with dynamic
         * retargeting and duration scaling guarantees:
         *   1. Velocity is preserved across continuous held moves (no dead stops).
         *   2. The camera effortlessly glides with the moving focus at full speed.
         * ==================================================================== */

        // ----------------------------------------------------------------
        // RETARGETING LOGIC (The "Zeno's Paradox" Fix)
        // ----------------------------------------------------------------
        // If an animation is already running for this axis, check if the
        // new target is exactly the same as the current target.
        if (this[stateKey] && this[animIdKey]) {
            if (Math.abs(this[stateKey].target - targetScroll) < SCROLL_SNAP_THRESHOLD) {
                // Target is unchanged, do nothing, let existing animation complete
                return;
            } else {
                // The target HAS changed (e.g. the user pressed Down while mid-scroll).
                // Scale duration proportionally to remaining distance, while enforcing
                // a fluid minimum duration floor to prevent premature fast-scroll rush.
                const remainingDistance = Math.abs(targetScroll - currentScroll);
                const originalDistance = Math.abs(targetScroll - this[stateKey].startScroll) || 1;
                const scaledDuration = Math.round(durationToUse * Math.min(remainingDistance / originalDistance, 1));

                // ------------------------------------------------------------
                // MOMENTUM CONTINUITY FLOOR
                // ------------------------------------------------------------
                // When pressing keys briskly during normal navigation, retargeting
                // must NOT abruptly collapse duration down to 50ms (which feels
                // like an uncontrollable fast-scroll hair-trigger).
                // Clamping the minimum retarget duration to 75% of base duration
                // (~150ms for 200ms vertical scrolls) guarantees that deliberate
                // multi-taps preserve fluid visual momentum.
                // ------------------------------------------------------------
                const minDurationFloor = Math.round(durationToUse * 0.75);

                // Update runtime tracking state to retarget from current position
                this[stateKey].startScroll = currentScroll;
                this[stateKey].target = targetScroll;
                this[stateKey].startTime = null; // Will reset on next RAF
                this[stateKey].duration = Math.max(minDurationFloor, scaledDuration);
                this[stateKey].isLargeScroll = isVertical && Math.abs(targetScroll - currentScroll) > 320;
                return;
            }
        }

        // Flag transitions that cover substantial vertical distance (e.g. hero ↔ row)
        // to use an S-curve easing profile rather than pure deceleration
        const isLargeScroll = isVertical && Math.abs(targetScroll - currentScroll) > 320;

        // Create new animation state
        this[stateKey] = {
            container,
            track,
            startScroll: currentScroll,
            target: targetScroll,
            startTime: null, // Initialized in first RAF frame
            duration: durationToUse,
            isLargeScroll
        };

        // Standard easeOutQuad: fast start, smooth deceleration (t * (2 - t))
        const easeOutQuad = (t) => t * (2 - t);

        // Smoothstep S-curve for large vertical transitions (e.g. hero carousel ↔ first content row):
        // Starts with a gentle acceleration ramp (zero initial jerk) so frame 1 doesn't spike
        // on TV compositors, cruises smoothly, and decelerates into landing without frame drops.
        const easeSmoothStep = (t) => t * t * (3 - 2 * t);

        // SMOOTH ARRIVAL BLEND: For the last 15% of animation time, rescale
        // easeOutQuad over the remaining distance. This maintains velocity
        // continuity at the transition point AND ensures velocity smoothly
        // reaches 0 at t=1 — eliminating the final-frame micro-jump that
        // occurs with vanilla easeOutQuad (which reaches 99% at 90% time).
        const EASE_BLEND = 0.85;
        const blendAt = easeOutQuad(EASE_BLEND);
        const blendRemaining = 1 - blendAt;
        const blendDuration = 1 - EASE_BLEND;

        // Animation loop
        const animate = (time) => {
            const state = this[stateKey];
            if (!state) return;

            // Initialize startTime on the first actual frame if not set
            if (!state.startTime) {
                state.startTime = time;
            }

            const elapsed = time - state.startTime;
            const progress = Math.min(elapsed / state.duration, 1);

            // For large vertical transitions (e.g. hero carousel ↔ first row), use the gentle
            // smoothstep curve to keep initial velocity safe for TV compositing. For standard
            // row-to-row navigation, use blended easeOutQuad for maximum responsiveness.
            const eased = state.isLargeScroll
                ? easeSmoothStep(progress)
                : progress < EASE_BLEND
                  ? easeOutQuad(progress)
                  : blendAt + blendRemaining * easeOutQuad((progress - EASE_BLEND) / blendDuration);

            // Interpolate between start and target
            const distance = state.target - state.startScroll;
            const newScroll = state.startScroll + distance * eased;

            // Apply scroll position
            if (isVertical) {
                if (scrollMode === 'gpu') {
                    // Update GPU transform coordinates using pre-cached track element
                    const currentTrack = state.track;
                    if (currentTrack) {
                        currentTrack.style.transform = `translate3d(0px, -${newScroll}px, 0px)`;
                        currentTrack.style.webkitTransform = `translate3d(0px, -${newScroll}px, 0px)`;
                    }
                    // PERFORMANCE: Writing scrollTop dirties the layout tree even when the
                    // value is unchanged, forcing reflow work on every ~16ms frame while GPU
                    // transforms are actively scrolling the track. Only write when the
                    // container has actually drifted from 0. The guarded read is cheap here
                    // since transform writes alone never dirty the layout tree.
                    if (container.scrollTop !== 0) {
                        container.scrollTop = 0;
                    }
                } else {
                    // Write vertical scroll position directly to container.
                    // CRITICAL PERFORMANCE RULE: Do NOT read scrollLeft or other layout
                    // metrics here! Setting scrollTop dirties the layout tree. Reading
                    // scrollLeft immediately afterwards forces a full synchronous reflow
                    // on every 16ms animation frame, reducing complex pages like HomePage
                    // (with 1500+ DOM nodes) down to a laggy 3 FPS.
                    state.container.scrollTop = newScroll;
                }
            } else {
                state.container.scrollLeft = newScroll;
            }

            if (progress < 1) {
                // Continue animation loop on the next frame
                this[animIdKey] = requestAnimationFrame(animate);
            } else {
                // Snap to exact target and clean up animation state
                if (isVertical) {
                    if (scrollMode === 'gpu') {
                        const currentTrack = state.track;
                        if (currentTrack) {
                            currentTrack.style.transform = `translate3d(0px, -${state.target}px, 0px)`;
                            currentTrack.style.webkitTransform = `translate3d(0px, -${state.target}px, 0px)`;
                        }
                        // PERFORMANCE: Guard the final clamp as well, so animating into a
                        // container already resting at 0 never dirties a clean layout tree.
                        if (container.scrollTop !== 0) {
                            container.scrollTop = 0;
                        }
                    } else {
                        state.container.scrollTop = state.target;
                    }
                    // STABILIZATION: Settle any horizontal drift once at animation completion,
                    // avoiding per-frame layout recalculations during motion.
                    if (state.container.scrollLeft !== 0) {
                        state.container.scrollLeft = 0;
                    }
                } else {
                    state.container.scrollLeft = state.target;
                }
                this[animIdKey] = null;
                this[stateKey] = null;
                this._checkScrollFinished();
            }
        };

        // Note: For the very first frame, we don't have a 'time' yet,
        // so we let the animate function initialize it.
        this[animIdKey] = requestAnimationFrame(animate);
    }

    /**
     * ========================================================================
     * APPLE-STYLE SPRING SCROLL ENGINE (velocity-driven, opt-in)
     * ========================================================================
     * Integrates a damped harmonic oscillator (see SpringPhysics.js) inside
     * a RAF loop. Engine guarantees:
     *   1. VELOCITY CONTINUITY: retargeting only re-aims the spring — the
     *      current velocity is untouched — so held D-pad key repeats produce
     *      one continuous camera glide instead of restart-from-zero curves.
     *   2. FIXED-STEP INTEGRATION: semi-implicit Euler with ≤8ms substeps,
     *      so trajectories are identical on 30/60/120 Hz displays.
     *   3. DETERMINISTIC SETTLE: snaps when both |Δx| < 0.3px and |v| <
     *      0.015px/ms, with a hard SPRING_MAX_DURATION_MS timeout net.
     *
     * Shared state schema (also reused by the horizontal GPU track spring):
     *   { container, track, axis, scrollMode, omega, zeta, x, v, target,
     *     startTime, lastFrameTime, elapsed, physics, _write, _finalize }
     *
     * @param {Object} p
     * @param {string} p.stateKey - Axis state slot ('_verticalScrollState' | '_horizontalScrollState')
     * @param {string} p.animIdKey - Axis RAF id slot
     * @param {HTMLElement} p.container - Scrollable container
     * @param {HTMLElement|null} p.track - Vertical GPU compositor track (or null)
     * @param {number} p.currentScroll - Current scroll position, px
     * @param {number} p.targetScroll - Target scroll position, px
     * @param {number} p.duration - Settle budget from duration preference, ms
     * @param {boolean} p.isVertical - True for vertical axis
     * @param {'gpu'|'native'|'current'|'instant'} p.scrollMode - Active axis scroll mode
     * @private
     */
    _springScrollTo({
        stateKey,
        animIdKey,
        container,
        track,
        currentScroll,
        targetScroll,
        duration,
        isVertical,
        scrollMode
    }) {
        const existing = this[stateKey];

        if (existing && existing.physics) {
            if (Math.abs(existing.target - targetScroll) < SCROLL_SNAP_THRESHOLD) {
                // Unchanged destination — let the in-flight engine finish.
                return;
            }
            // VELOCITY CONTINUITY: re-aim without touching current (x, v).
            // Fresh settle budget and glide band for long re-aims.
            existing.target = targetScroll;
            existing.startTime = null;
            existing.elapsed = 0;
            existing.glide = null;
            existing.glideZone = Math.min(
                GLIDE_ZONE_MAX_PX,
                Math.abs(existing.target - existing.x) * GLIDE_ZONE_FRACTION
            );
            // Rail/fling derive their speed from remaining distance — refresh.
            if (existing.engine === 'rail') {
                this._refreshRailState(existing, duration);
            } else if (existing.engine === 'fling') {
                this._refreshFlingState(existing, duration);
            }
            return;
        }
        // Switching engines mid-flight: cleanly stop the old easing loop
        // before the physics engine takes over the axis state slot.
        if (existing && this[animIdKey]) {
            cancelAnimationFrame(this[animIdKey]);
            this[animIdKey] = null;
        }

        // ----------------------------------------------------------------
        // Axis write strategy — mirrors the easing engine exactly:
        //   vertical gpu    → translate3d on .vertical-scroll-track
        //   vertical native → container.scrollTop
        //   horizontal      → container.scrollLeft
        // ----------------------------------------------------------------
        let write;
        let finalize;

        if (isVertical) {
            write = (value) => {
                if (scrollMode === 'gpu') {
                    const currentTrack = this[stateKey] && this[stateKey].track;
                    if (currentTrack) {
                        currentTrack.style.transform = `translate3d(0px, -${value}px, 0px)`;
                        currentTrack.style.webkitTransform = `translate3d(0px, -${value}px, 0px)`;
                    }
                    // PERFORMANCE: only write scrollTop when it has drifted
                    // (identical rule to the easing engine's GPU branch).
                    if (container.scrollTop !== 0) {
                        container.scrollTop = 0;
                    }
                } else {
                    // CRITICAL PERFORMANCE RULE: no layout reads while writing
                    // (see the easing engine's scrollTop branch).
                    container.scrollTop = value;
                }
            };
            finalize = (value) => {
                if (scrollMode === 'gpu') {
                    const currentTrack = track;
                    if (currentTrack) {
                        currentTrack.style.transform = `translate3d(0px, -${value}px, 0px)`;
                        currentTrack.style.webkitTransform = `translate3d(0px, -${value}px, 0px)`;
                    }
                    if (container.scrollTop !== 0) {
                        container.scrollTop = 0;
                    }
                } else {
                    container.scrollTop = value;
                }
                // STABILIZATION: settle any horizontal drift once on completion.
                if (container.scrollLeft !== 0) {
                    container.scrollLeft = 0;
                }
            };
        } else {
            write = (value) => {
                container.scrollLeft = value;
            };
            finalize = (value) => {
                container.scrollLeft = value;
            };
        }

        this[stateKey] = this._createPhysicsState({
            engine: this._resolvePhysicsEngine(),
            axis: isVertical ? 'vertical' : 'horizontal',
            container,
            track,
            scrollMode,
            current: currentScroll,
            target: targetScroll,
            duration,
            _write: write,
            _finalize: finalize
        });

        this._runSpringLoop(stateKey, animIdKey);
    }

    /**
     * Apple-style spring for the horizontal GPU compositor track
     * (.row-items-track). Used by scrollIntoView when horizontal scroll mode
     * is 'gpu' and physics is enabled — CSS cubic-bezier transitions cannot
     * reproduce a spring/follower, so the JS integrator drives the transform
     * per frame instead (data-scroll-physics disables the CSS transition for
     * exactly this reason).
     *
     * Reuses the horizontal axis state slot so cancelAnimation, isAnimating
     * and scroll:finished behave identically to every other engine.
     *
     * @param {HTMLElement} track - .row-items-track element to slide
     * @param {number} targetX - Target horizontal offset, px
     * @param {number} currentX - Current horizontal offset, px
     * @param {boolean} isRtl - RTL layout flag
     * @private
     */
    _springTrackHorizontal(track, targetX, currentX, isRtl) {
        const stateKey = '_horizontalScrollState';
        const animIdKey = '_horizontalScrollAnimationId';
        const existing = this[stateKey];

        if (existing && existing.physics) {
            if (Math.abs(existing.target - targetX) < SCROLL_SNAP_THRESHOLD) {
                return;
            }
            // VELOCITY CONTINUITY: re-aim without touching current (x, v).
            // Fresh settle budget and glide band for long re-aims.
            existing.target = targetX;
            existing.startTime = null;
            existing.elapsed = 0;
            existing.glide = null;
            existing.glideZone = Math.min(
                GLIDE_ZONE_MAX_PX,
                Math.abs(existing.target - existing.x) * GLIDE_ZONE_FRACTION
            );
            // Rail/fling derive their speed from remaining distance — refresh.
            if (existing.engine === 'rail') {
                this._refreshRailState(existing, this.getHorizontalScrollDuration());
            } else if (existing.engine === 'fling') {
                this._refreshFlingState(existing, this.getHorizontalScrollDuration());
            }
            return;
        }
        if (existing && this[animIdKey]) {
            cancelAnimationFrame(this[animIdKey]);
            this[animIdKey] = null;
        }

        const transformFor = (value) => (isRtl ? `translate3d(${value}px, 0, 0)` : `translate3d(-${value}px, 0, 0)`);

        this[stateKey] = this._createPhysicsState({
            engine: this._resolvePhysicsEngine(),
            axis: 'horizontal',
            container: track,
            track,
            scrollMode: 'gpu',
            current: currentX,
            target: targetX,
            duration: this.getHorizontalScrollDuration(),
            _write: (value) => {
                const transformStr = transformFor(value);
                track.style.webkitTransform = transformStr;
                track.style.transform = transformStr;
            },
            _finalize: (value) => {
                const transformStr = transformFor(value);
                track.style.webkitTransform = transformStr;
                track.style.transform = transformStr;
            }
        });

        this._runSpringLoop(stateKey, animIdKey);
    }

    /**
     * Builds the physics state for whichever engine was resolved. Shared by
     * all integration surfaces (vertical GPU/native, horizontal native, and
     * the horizontal GPU track) so every engine behaves identically on both
     * axes. Rail and fling derive their speed budgets from the hop distance
     * and duration preference; chase derives τ; spring derives ω/ζ/v₀.
     *
     * @param {Object} o
     * @param {'spring'|'chase'|'rail'|'fling'} o.engine - Resolved engine
     * @param {'vertical'|'horizontal'} o.axis - Motion axis
     * @param {HTMLElement} o.container - Scrollable container (or track)
     * @param {HTMLElement|null} o.track - GPU compositor track (or null)
     * @param {string} o.scrollMode - Active axis scroll mode
     * @param {number} o.current - Current scroll position, px
     * @param {number} o.target - Target scroll position, px
     * @param {number} o.duration - Settle budget from duration preference, ms
     * @param {Function} o._write - Per-frame position writer
     * @param {Function} o._finalize - Target snap on completion
     * @returns {Object} Physics state consumed by _runSpringLoop
     * @private
     */
    _createPhysicsState({ engine, axis, container, track, scrollMode, current, target, duration, _write, _finalize }) {
        const distance = target - current;
        const durationFloor = Math.max(duration || 0, SPRING_MIN_DURATION_MS);
        // Engines with exponential tails get a terminal glide band; rail
        // already decelerates linearly, so it never needs the handover.
        const glideZone = engine === 'rail' ? 0 : Math.min(GLIDE_ZONE_MAX_PX, Math.abs(distance) * GLIDE_ZONE_FRACTION);
        const base = {
            physics: true,
            engine,
            axis,
            container,
            track,
            scrollMode,
            x: current,
            v: 0,
            target,
            startTime: null,
            lastFrameTime: null,
            elapsed: 0,
            glide: null,
            glideZone,
            _write,
            _finalize
        };

        if (engine === 'chase') {
            // One exponential per frame; τ from the duration preference.
            return { ...base, tau: durationFloor / CHASE_TAU_FACTOR };
        }
        if (engine === 'rail') {
            // Constant-velocity slope matched to the easing engine's initial
            // departure speed (2·D/T), with a linear deceleration tail.
            const dist = Math.abs(distance);
            return {
                ...base,
                speed: (2 * dist) / durationFloor,
                decelZone: RAIL_DECEL_ZONE_FRACTION * dist
            };
        }
        if (engine === 'fling') {
            // Momentum sweep: velocity-capped follower. The launch speed
            // ceiling derives from the hop so distant targets sweep faster.
            const dist = Math.abs(distance);
            return {
                ...base,
                tau: durationFloor / CHASE_TAU_FACTOR,
                vCap: Math.max(FLING_VELOCITY_MULTIPLIER * ((2 * dist) / durationFloor), 0.3)
            };
        }
        // Default: critically damped spring (Apple TV).
        const { omega, zeta, v0 } = createSpring(distance, durationFloor);
        return { ...base, omega, zeta, v: v0 };
    }

    /**
     * Recomputes rail speed parameters after a mid-flight retarget (the
     * remaining distance changed, so the fixed slope must re-derive).
     * @param {Object} state - Rail physics state
     * @param {number} duration - Settle budget, ms
     * @private
     */
    _refreshRailState(state, duration) {
        const dist = Math.abs(state.target - state.x);
        state.speed = (2 * dist) / Math.max(duration || 0, SPRING_MIN_DURATION_MS);
        state.decelZone = RAIL_DECEL_ZONE_FRACTION * dist;
    }

    /**
     * Recomputes fling momentum ceiling after a mid-flight retarget.
     * @param {Object} state - Fling physics state
     * @param {number} duration - Settle budget, ms
     * @private
     */
    _refreshFlingState(state, duration) {
        const dist = Math.abs(state.target - state.x);
        state.vCap = Math.max(
            FLING_VELOCITY_MULTIPLIER * ((2 * dist) / Math.max(duration || 0, SPRING_MIN_DURATION_MS)),
            0.3
        );
    }

    /**
     * Shared RAF driver for every physics axis. Integrates the engine with
     * fixed substeps (8ms for the spring's second-order integrator, 16ms for
     * the follower engines), records frame deltas into the adaptive sampler,
     * and delegates per-frame writes to the state's _write closure.
     *
     * @param {string} stateKey - Axis state slot
     * @param {string} animIdKey - Axis RAF id slot
     * @private
     */
    _runSpringLoop(stateKey, animIdKey) {
        const animate = (time) => {
            const s = this[stateKey];
            if (!s || !s.physics) return;

            // Anchor the clock on the very first RAF frame (dt = 0), or
            // re-anchor after a retarget refreshed the settle budget.
            if (s.lastFrameTime === null) {
                s.lastFrameTime = time;
            }
            if (s.startTime === null) {
                s.startTime = time;
            }

            // Adaptive sampling: feed the RAW interval before clamping, but
            // reject genuine stalls (hidden tab) from poisoning the median.
            const rawDelta = time - s.lastFrameTime;
            s.lastFrameTime = time;
            if (rawDelta > 0 && rawDelta < ADAPTIVE_SAMPLE_REJECT_MAX_MS) {
                this._recordFrameDelta(rawDelta);
            }

            // FIXED CADENCE STEP: integrate the same dt every frame — the
            // clamped median of recent measured intervals. Consuming each
            // frame's actual interval produced wild per-paint steps on janky
            // delivery (fast frames = small steps, late frames = teleports),
            // the source of the "scroll splits into two uneven parts" hitch,
            // worst at long duration settings where late frames are frequent.
            // Constant dt paints equal steps; late frames only paint earlier
            // state, and slow panels stretch the animation proportionally.
            let dt = stableFrameDelta(this._frameSamples, NOMINAL_FRAME_MS);

            // Settle budget accumulates INTEGRATED simulation time, not wall
            // clock (identical accounting to TouchHorizontalScroller). Timing
            // the SPRING_MAX_DURATION_MS hard timeout on wall clock fired the
            // finalize() snap while the physics was still tens of pixels
            // short of the target — the visible post-scroll "nudge" (20-30px
            // jump) on slow Tizen hardware. Retarget re-anchoring restarts
            // the budget, preserving the original "fresh settle budget" intent.
            s.elapsed += dt;

            if (s.glide) {
                // TERMINAL GLIDE: constant-deceleration ease-out quadratic to
                // the target. Exponential tails fall below ~1px/frame for the
                // last third of a hop — motion appears to stop, then creeps
                // the remainder (perceived 2-part hitch on slow panels). The
                // glide keeps visible speed from vEntry down to 0 exactly at
                // the target within 2·rem/v of sim time.
                const f = Math.min((s.elapsed - s.glide.start) / s.glide.dur, 1);
                const eased = 1 - (1 - f) * (1 - f);
                s.x = s.glide.x0 + (s.target - s.glide.x0) * eased;
                // Snap bittersweet settle criterion while gliding is disabled —
                // only the landing (f=1) or the timeout may end the state.
                s._write(s.x);
                if (f >= 1 || s.elapsed >= SPRING_MAX_DURATION_MS) {
                    s._finalize(s.target);
                    this[animIdKey] = null;
                    this[stateKey] = null;
                    this._checkScrollFinished();
                    return;
                }
                this[animIdKey] = requestAnimationFrame(animate);
                return;
            }

            while (dt > 0) {
                const h = Math.min(dt, s.engine === 'spring' ? SPRING_SUBSTEP_MS : 16);
                const [nx, nv] = this._advancePhysics(s, h);
                s.x = nx;
                s.v = nv;
                dt -= h;
            }
            s._write(s.x);

            // Glide handover: distance remaining inside the glide band and
            // still moving toward the target → replace the exponential tail.
            const remaining = Math.abs(s.target - s.x);
            if (remaining > 0 && remaining <= s.glideZone && !s.glide) {
                const vEntry = Math.abs(s.v);
                // Soft entry: clamp the starting speed into [2·floor, cap] so
                // the handover never reads as a jerk, then bound the glide
                // duration between a multi-frame minimum and the longest that
                // still keeps the average closing speed perceptible.
                const vStart = Math.min(Math.max(vEntry, 2 * GLIDE_FALLBACK_SPEED_PX_MS), GLIDE_ENTRY_SPEED_CAP_PX_MS);
                const durRaw = (2 * remaining) / vStart;
                const dur = Math.min(Math.max(durRaw, GLIDE_MIN_DURATION_MS), remaining / GLIDE_FALLBACK_SPEED_PX_MS);
                s.glide = { x0: s.x, dur, start: s.elapsed };
            }

            const settled = this._isPhysicsSettled(s);

            if (settled || s.elapsed >= SPRING_MAX_DURATION_MS) {
                s._finalize(s.target);
                this[animIdKey] = null;
                this[stateKey] = null;
                this._checkScrollFinished();
                return;
            }

            this[animIdKey] = requestAnimationFrame(animate);
        };

        this[animIdKey] = requestAnimationFrame(animate);
    }

    /**
     * One integration substep for the state's active engine.
     * @param {Object} s - Physics state
     * @param {number} h - Substep duration, ms
     * @returns {[number, number]} New [x, v]
     * @private
     */
    _advancePhysics(s, h) {
        switch (s.engine) {
            case 'chase':
                return chaseStep(s.x, s.target, s.tau, h);
            case 'rail':
                return railStep(s.x, s.target, s.speed, s.decelZone, h);
            case 'fling':
                return flingStep(s.x, s.v, s.target, s.tau, s.vCap, h);
            default:
                return springStep(s.x, s.v, s.target, s.omega, s.zeta, h);
        }
    }

    /**
     * Engine-specific settle criterion. The spring requires velocity and
     * distance convergence; chase/rail settle on distance alone (their
     * crossing guards guarantee no residual motion); fling also waits for
     * its momentum to dissipate.
     *
     * @param {Object} s - Physics state
     * @returns {boolean}
     * @private
     */
    _isPhysicsSettled(s) {
        const dx = Math.abs(s.target - s.x);
        if (s.engine === 'spring') {
            return dx < SPRING_SETTLE_DISTANCE_PX && Math.abs(s.v) < SPRING_SETTLE_VELOCITY_PX_MS;
        }
        if (s.engine === 'fling') {
            return dx < PHYSICS_SETTLE_DISTANCE_PX && Math.abs(s.v) < SPRING_SETTLE_VELOCITY_PX_MS;
        }
        return dx < PHYSICS_SETTLE_DISTANCE_PX;
    }

    /**
     * Cancel an active scroll animation.
     * @param {'vertical'|'horizontal'} [direction='vertical'] - Which axis to cancel
     */
    cancelAnimation(direction = 'vertical') {
        if (direction === 'vertical') {
            if (this._verticalScrollAnimationId) {
                cancelAnimationFrame(this._verticalScrollAnimationId);
                this._verticalScrollAnimationId = null;
            }
            this._verticalScrollState = null;

            // Clear any active native scroll timer and reset native state
            if (this._nativeScrollTimeout) {
                clearTimeout(this._nativeScrollTimeout);
                this._nativeScrollTimeout = null;
            }
            this._nativeScrollActive = false;
            this._nativeTargetScroll = null;
        } else {
            if (this._horizontalScrollAnimationId) {
                cancelAnimationFrame(this._horizontalScrollAnimationId);
                this._horizontalScrollAnimationId = null;
            }
            this._horizontalScrollState = null;
        }
        this._checkScrollFinished();
    }

    /**
     * Find the nearest scrollable parent for an element.
     * Searches for known scroll containers (.modal-options, .filter-main,
     * .page-content) and caches the .page-content reference for performance.
     *
     * @param {HTMLElement} element - Element to find scroll container for
     * @returns {HTMLElement|null} The scrollable container, or null
     */
    getScrollContainer(element) {
        if (!element) return null;

        // ---------------------------------------------------------------------
        // 1. ISOLATE SUB-LIBRARIES MENU FROM SIDEBAR CONTAINER
        // ---------------------------------------------------------------------
        // In modern collapsed layouts, #sidebar-sub-libraries renders as a separate
        // floating popover menu beside the sidebar rail. In normal expanded layout,
        // it expands as an accordion. In both modes, navigating within this menu
        // must NEVER scroll .sidebar-content or push the sidebar items upward.
        // If the popover itself has reached its max-height and overflows, we scroll
        // the popover itself directly, keeping the sidebar completely stationary.
        // ---------------------------------------------------------------------
        const subLibs = element.closest('#sidebar-sub-libraries');
        if (subLibs) {
            // Check if #sidebar-sub-libraries is actively overflowing with auto/scroll styles
            const hasPopoverScroll =
                subLibs.scrollHeight > subLibs.clientHeight && window.getComputedStyle(subLibs).overflowY !== 'visible';
            return hasPopoverScroll ? subLibs : null;
        }

        // ---------------------------------------------------------------------
        // 2. SIDEBAR CONTENT SCROLL CONTAINER
        // ---------------------------------------------------------------------
        // On Smart TV platforms like Tizen, native browser scrolling during focus
        // changes is disabled to prevent layout jitter. When the sidebar items
        // overflow the screen viewport height (e.g. many custom libraries, plugin
        // shortcuts, or low display heights), ScrollController must manage vertical
        // scrolling directly. Returning .sidebar-content ensures focus-driven smooth
        // scrolling works reliably across all sidebar layout configurations.
        // Elements within #sidebar-sub-libraries were already intercepted above.
        // ---------------------------------------------------------------------
        const sidebarContent = element.closest('.sidebar-content');
        if (sidebarContent) {
            // Deliver the sidebar container reference so scroll calculations execute
            return sidebarContent;
        }

        // ---------------------------------------------------------------------
        // 3. GENERIC SCROLLABLE CONTAINERS
        // ---------------------------------------------------------------------
        // Inspect known scrollable container structures used in modals, filter
        // dialogs, settings, user grids, and media info overlays.
        // Including .filter-sidebar ensures vertical category navigation in the
        // library filter modal scrolls smoothly on TV platforms and keyboard nav.
        // ---------------------------------------------------------------------
        const container = element.closest(
            '.users-grid, .modal-options, .modal-body, .filter-main, .filter-sidebar, .page-content, .settings-sidebar, .sidebar-libraries-wrapper, .media-info-scrollable, .identify-results-list'
        );

        return container;
    }

    /**
     * Scroll an element into view with intelligent positioning.
     *
     * Handles multiple scroll strategies:
     *   - Row-based vertical: Aligns the parent .media-row based on user preference
     *     (bottom by default to minimize scroll frequency, middle/centered, or top),
     *     guarded by a threshold to prevent jitter on horizontal nav within the same row.
     *   - Hero section: Always scrolls to absolute 0.
     *   - Horizontal: Centers the element within its .row-items container.
     *   - Generic vertical: Simple scroll-into-view with margins for
     *     grids, lists, or containers without .media-row structure.
     *
     * @param {HTMLElement} element - The element to scroll into view
     * @param {Object} [config] - Section config from FocusManager
     * @param {number} [config.scrollOffsetTop=0] - Custom top offset
     * @param {Object} [options] - Scroll options
     * @param {boolean} [options.scroll=true] - Whether to scroll at all
     * @param {boolean} [options.skipScroll=false] - Skip scroll entirely
     */
    scrollIntoView(element, config = {}, options = {}) {
        // ====================================================================
        // OPTION GUARD: SKIP SCROLL
        // ====================================================================
        // Under certain navigation contexts (such as restoring exact page states
        // from history or back operations), the scroll container's offset has
        // already been restored manually. In these situations, attempting to scroll
        // the newly focused element into view can override the restored offset or
        // cause jarring visual jumps. Setting options.skipScroll bypasses the entire
        // scroll calculation and paint routine.
        // ====================================================================
        if (options.skipScroll) {
            return;
        }

        // Resolve the scroll container for this element
        const pageContent = this.getScrollContainer(element);

        // ----------------------------------------------------------------
        // HERO CAROUSEL FAST PATH
        // ----------------------------------------------------------------
        // The hero carousel always lives at scroll position 0. Skip all
        // offset computation (which forces synchronous layout reflows via
        // getCumulativeOffsetTop / getBoundingClientRect) and just scroll
        // to the top directly. This shaves 2-5ms off every hero ↔ row
        // focus transition on Tizen hardware.
        // ----------------------------------------------------------------
        if (element.id === 'hero-carousel-container' || element.closest('#hero-carousel-container')) {
            if (pageContent) {
                // ============================================================
                // HERO FAST PATH SNAP CHECK
                // ============================================================
                // When moving up from rows to the hero carousel across large
                // distances, honor pref:snapLargeScrolls if enabled so users
                // who prefer instant jumps don't wait for animations.
                // ============================================================
                const currentScroll = this.getVerticalScroll(pageContent);
                const viewHeight = pageContent.clientHeight;
                const scrollDelta = Math.abs(currentScroll);
                const snapEnabled = storage.getItem('pref:snapLargeScrolls') === 'true';
                const forceInstant = snapEnabled && scrollDelta > viewHeight * LARGE_SCROLL_SNAP_FRACTION;

                this.smoothScrollTo(
                    pageContent,
                    0,
                    options.instantScroll || forceInstant ? 0 : this.getVerticalScrollDuration()
                );
            }
            return;
        }

        // Helper: compute element offset relative to a scroll container
        // using offsetTop to remain immune to actively animating scroll positions.
        //
        // PERFORMANCE RULES FOR CACHING:
        //
        //   ✓ CACHE stable elements (e.g. .media-row): their offsetTop within
        //     .page-content is fixed for the page lifetime — safe to cache.
        //
        //   ✗ DO NOT cache card elements inside .row-items-track:
        //     - The track uses CSS transform: translate3d(), which breaks the
        //       offsetParent chain before reaching .page-content.
        //     - The fallback path uses getBoundingClientRect(), which is
        //       scroll-relative — its value changes as the page scrolls.
        //     - Caching a scroll-relative BoundingRect value poisons the cache
        //       with a stale number that causes wrong scroll targets on the next keypress.
        //     - VirtualCardRow also reuses/repositions DOM nodes, so the same
        //       element key can represent a different card on the next window update.
        const getCumulativeOffsetTop = (el, relativeTo) => {
            if (!el || !relativeTo) return 0;

            // -------------------------------------------------------------
            // CACHE READ GUARD: Check cache ONLY for stable .media-row nodes
            // -------------------------------------------------------------
            // Dynamic cards in grids/lists must never read from the cache because
            // their offsets are dependent on virtual spacers and layout shifting.
            // -------------------------------------------------------------
            if (el.classList.contains('media-row')) {
                const cached = this._offsetCache.get(el);
                if (cached !== undefined && cached.container === relativeTo) {
                    return cached.value;
                }
            }

            let top = 0;
            let current = el;

            while (current && current !== relativeTo && current !== document.body) {
                top += current.offsetTop || 0;
                current = current.offsetParent;
            }

            if (current === relativeTo) {
                // PERFORMANCE: Only cache positions of static full-width .media-row elements.
                // Media rows never shift dynamically within .page-content.
                // Dynamic grid cards, list items, or elements preceded by dynamic
                // spacers (such as #grid-top-spacer in LibraryPage) change their effective
                // offset when rows are prepended or evicted; caching them leads to
                // stale scroll targets that throw the focused element off-screen.
                if (el.classList.contains('media-row')) {
                    this._offsetCache.set(el, { container: relativeTo, value: top });
                }
            } else {
                // Fallback: the chain broke early (e.g. CSS transform on an ancestor
                // or a fixed-position portal). Use getBoundingClientRect as a last resort.
                //
                // IMPORTANT: getBoundingClientRect() is SCROLL-RELATIVE — it includes
                // the container's current scrollTop in its result. This means the value
                // will be WRONG if the page scrolls between compute and use.
                // We compensate by adding scrollTop, but we CANNOT cache this result
                // because the effective scrollTop used at computation time won't match
                // the scrollTop at the next call site.
                const elRect = el.getBoundingClientRect();
                const relRect = relativeTo.getBoundingClientRect();
                top = elRect.top - relRect.top + this.getVerticalScroll(relativeTo);
                // NOT cached — value is volatile
            }

            return top;
        };

        // ----------------------------------------------------------------
        // VERTICAL EPISODE LIST FAST PATH
        // ----------------------------------------------------------------
        // For vertical episode list items (e.g. season episodes list & Next Up list),
        // calculate target scroll according to the configured vertical alignment preference
        // (bottom by default, middle/centered, or top).
        // ----------------------------------------------------------------
        const isVerticalListCard =
            element.closest('.episode-row-card, .episode-row, .episode-list-container') ||
            element.classList.contains('episode-row-card');
        if (isVerticalListCard && pageContent) {
            const cardEl = element.closest('.episode-row-card') || element;
            const cardTop = getCumulativeOffsetTop(cardEl, pageContent);
            const cardHeight = cardEl.offsetHeight || 100;
            const viewHeight = pageContent.clientHeight;
            const currentScroll = this.getVerticalScroll(pageContent);
            const alignment = this.getVerticalScrollAlignment();

            // Calculate ideal vertical target based on selected alignment mode
            let targetScroll;
            if (alignment === 'middle') {
                // Center the focused episode card within the viewport
                targetScroll = cardTop - viewHeight / 2 + cardHeight / 2;
            } else if (alignment === 'bottom') {
                // Bottom-align with comfortable headroom from the viewport bottom edge
                targetScroll = cardTop + cardHeight - viewHeight + 100;
            } else {
                // Classic top-aligned positioning with 180px top offset
                targetScroll = cardTop - 180;
            }

            // Guard against negative scroll offsets
            targetScroll = Math.max(0, targetScroll);

            // Active in-flight target awareness: compare against destination target
            // so mid-flight keypresses targeting the same alignment don't re-trigger
            const activeTarget =
                this._nativeScrollActive && this._nativeTargetScroll !== null
                    ? this._nativeTargetScroll
                    : this._verticalScrollState
                      ? this._verticalScrollState.target
                      : currentScroll;

            if (Math.abs(targetScroll - activeTarget) > 5) {
                this.smoothScrollTo(
                    pageContent,
                    targetScroll,
                    options.instantScroll ? 0 : this.getVerticalScrollDuration()
                );
            }
            return;
        }

        // ----------------------------------------------------------------
        // Determine if we should use row-based vertical scrolling
        // Row scroll aligns the entire .media-row to a top offset
        // ----------------------------------------------------------------
        const row = pageContent ? element.closest('.media-row') : null;
        let useRowScroll = !!row;
        let activePageContent = pageContent; // May be nulled for hero

        if (useRowScroll) {
            // HERO EXCEPTION: Hero sections always snap to scroll position 0
            const isHero = row.classList.contains('details-main-split');

            if (isHero) {
                // ============================================================
                // Force scroll to absolute top for hero/title split sections.
                // Forward instantScroll and honor pref:snapLargeScrolls so rapid
                // navigation up to hero snaps cleanly without forcing animation.
                // ============================================================
                const currentScroll = this.getVerticalScroll(pageContent);
                const viewHeight = pageContent.clientHeight;
                const scrollDelta = Math.abs(currentScroll);
                const snapEnabled = storage.getItem('pref:snapLargeScrolls') === 'true';
                const forceInstant = snapEnabled && scrollDelta > viewHeight * LARGE_SCROLL_SNAP_FRACTION;

                this.smoothScrollTo(
                    pageContent,
                    0,
                    options.instantScroll || forceInstant ? 0 : this.getVerticalScrollDuration()
                );
                // Disable further row-based alignment logic and generic vertical scroll
                useRowScroll = false;
                activePageContent = null;
            }
            // TALL ROW EXCEPTION: If the row is much taller than the viewport,
            // disable row-alignment to prevent jarring jumps.
            else if (row.offsetHeight > pageContent.clientHeight * TALL_ROW_MULTIPLIER) {
                useRowScroll = false;
            }
            // GRID EXCEPTION: If the row contains a wrap-grid (like Season episodes),
            // row-based snapping will fail spectacularly on deep navigation.
            else if (row.querySelector('.person-grid')) {
                useRowScroll = false;
            }
        }

        // ====================================================================
        // DETAILS PAGE RICH METADATA TABLE SCROLL GROUNDING
        // ====================================================================
        // The rich metadata table sits directly beneath the hero split (.details-main-split).
        // On TV displays, both the hero action buttons and the rich metadata table are
        // designed to be viewed together in the upper section of the page.
        //
        // Previously, generic vertical scrolling treated the metadata table as an
        // arbitrary tall container and attempted to bottom-align it, triggering a 150-300px
        // smooth scroll down when entering metadata and a smooth scroll up when returning
        // to action buttons. On low-end ARM TV hardware, this violent bouncing between
        // adjacent elements forced heavy GPU raster invalidations on every keypress.
        //
        // By aligning the rich metadata table with the hero viewport (targetScroll = 0),
        // navigation between hero actions and rich metadata remains stationary, fluid,
        // and 100% instant with zero scroll hitching.
        // ====================================================================
        const isRichMeta =
            element.id === 'rich-meta' ||
            element.id === 'rich-meta-container' ||
            element.classList.contains('details-rich-meta') ||
            Boolean(element.closest('#rich-meta, .details-rich-meta, #rich-meta-container'));

        if (isRichMeta && pageContent && pageContent.querySelector('.details-main-split')) {
            const currentScroll = this.getVerticalScroll(pageContent);
            const viewHeight = pageContent.clientHeight;
            const scrollDelta = Math.abs(currentScroll);

            // If already browsing near the top of the details page, stay grounded at 0
            if (currentScroll < 350) {
                if (currentScroll > 0) {
                    this.smoothScrollTo(pageContent, 0, options.instantScroll ? 0 : this.getVerticalScrollDuration());
                }
            } else {
                // If entering rich metadata from deep rows below (e.g. episodes or seasons),
                // smoothly glide back to the top to reveal the hero and metadata table together
                const snapEnabled = storage.getItem('pref:snapLargeScrolls') === 'true';
                const forceInstant = snapEnabled && scrollDelta > viewHeight * LARGE_SCROLL_SNAP_FRACTION;
                this.smoothScrollTo(
                    pageContent,
                    0,
                    options.instantScroll || forceInstant ? 0 : this.getVerticalScrollDuration()
                );
            }

            // Grounding complete — bypass row-based and generic scroll-into-view
            useRowScroll = false;
            activePageContent = null;
        }

        // ----------------------------------------------------------------
        // Row-based vertical scrolling — ALIGN ACCORDING TO USER PREFERENCE
        // Targets the configured scroll alignment position for the parent .media-row:
        //   - 'bottom' (Default): Aligns row bottom to the viewport bottom with padding.
        //     Substantially reduces total scroll actions since rows already in view
        //     stay perfectly stationary without viewport jumping.
        //   - 'middle': Vertically centers the row in the viewport.
        //   - 'top': Classic Litefin behavior aligning the row near the top.
        //
        // A threshold (SCROLL_ALIGN_THRESHOLD) prevents micro-jitter when
        // navigating horizontally within the same row or between tightly
        // packed items (e.g. genre header → genre grid in the same row).
        // ----------------------------------------------------------------
        if (useRowScroll && row) {
            // Batch all DOM reads first (Samsung Tizen optimization)
            const rowTop = getCumulativeOffsetTop(row, pageContent);
            const rowHeight = row.offsetHeight || 0;
            const padding = config.scrollOffsetTop || DEFAULT_SCROLL_OFFSET_TOP;
            const viewHeight = pageContent.clientHeight;
            const currentScroll = this.getVerticalScroll(pageContent);
            const alignment = this.getVerticalScrollAlignment();

            // Compute ideal target scroll position based on alignment preference
            let targetScroll;
            if (alignment === 'middle') {
                // Middle alignment: center the entire .media-row vertically
                targetScroll = rowTop - viewHeight / 2 + rowHeight / 2;
            } else if (alignment === 'bottom') {
                // Bottom alignment: place row bottom cleanly near the viewport bottom.
                // Tuned to 18px offset to hit the ideal balance between keeping the succeeding row's
                // title strictly off-screen while giving card subtitles comfortable breathing room.
                const offsetBottom =
                    typeof config.scrollOffsetBottom === 'number'
                        ? config.scrollOffsetBottom
                        : DEFAULT_SCROLL_OFFSET_BOTTOM;
                targetScroll = rowTop + rowHeight - viewHeight + offsetBottom;
            } else {
                // Top alignment: row top sits at configured offset from viewport top
                targetScroll = rowTop - padding;
            }

            // Safety check: ensure the specific focused element is actually visible
            // at the computed scroll position. Handles tall-row edge cases where the
            // focused item might be below or above the visible area at the row-aligned position.
            //
            // OPTIMIZATION: Skip this check for VirtualCardRow items (detected via
            // data-virtual-index). Cards managed by VirtualCardRow are ALWAYS within
            // the visible window — the row guarantees this on every navigation.
            // The getCumulativeOffsetTop() for a card inside the track always falls
            // through to the getBoundingClientRect() fallback path (CSS transform on
            // the track breaks the offsetParent chain), which is scroll-relative and
            // forces a synchronous layout on every keypress. Skipping it for
            // virtual cards eliminates 2 forced layout flushes per navigation.
            const isVirtualCard = element.dataset && element.dataset.virtualIndex !== undefined;
            if (!isVirtualCard) {
                const elTop = getCumulativeOffsetTop(element, pageContent);
                const elBottom = elTop + element.offsetHeight;

                if (elBottom > targetScroll + viewHeight) {
                    // Element cut off at the bottom — adjust target scroll to keep it in view
                    targetScroll = elBottom - viewHeight + ROW_CUTOFF_BUFFER;
                } else if (elTop < targetScroll + padding) {
                    // Element cut off at the top — adjust target scroll to keep it in view
                    targetScroll = elTop - padding;
                }
            }

            // Never allow scrolling above the top boundary
            targetScroll = Math.max(0, targetScroll);

            // Only scroll if the delta exceeds the alignment threshold.
            // This prevents micro-jitter on horizontal nav within the same row,
            // and avoids unnecessary scrolls between tightly packed items
            // (e.g. genre header → genre grid within the same .media-row).
            //
            // ================================================================
            // RETARGETING & IN-FLIGHT ANIMATION AWARENESS
            // ================================================================
            // When an animation is actively in flight (native or JS RAF), comparing
            // targetScroll against the volatile mid-flight currentScroll produces false
            // deltas that retrigger the animation from the mid-flight position with
            // zero starting velocity, causing visual jumping and stutter.
            //
            // By comparing against the active in-flight destination target if present,
            // subsequent keypresses to items on the same row or within the same target
            // boundary allow the existing smooth transition to complete uninterrupted.
            // New targets across rows cleanly retarget without hitching.
            // ================================================================
            const activeTarget =
                this._nativeScrollActive && this._nativeTargetScroll !== null
                    ? this._nativeTargetScroll
                    : this._verticalScrollState
                      ? this._verticalScrollState.target
                      : currentScroll;

            const scrollDelta = Math.abs(targetScroll - activeTarget);
            if (scrollDelta > SCROLL_ALIGN_THRESHOLD) {
                // PERFORMANCE: For scroll distances exceeding ~45% of the viewport
                // (e.g. hero carousel ↔ first content row), snap instantly. The
                // Tizen compositor can't smoothly animate 500+ pixel scrolls without
                // dropping frames. Normal row-to-row deltas (~250px) remain smooth.
                // This is optional and controlled by pref:snapLargeScrolls.
                const snapEnabled = storage.getItem('pref:snapLargeScrolls') === 'true';
                const forceInstant = snapEnabled && scrollDelta > viewHeight * LARGE_SCROLL_SNAP_FRACTION;
                this.smoothScrollTo(
                    pageContent,
                    targetScroll,
                    options.instantScroll || forceInstant ? 0 : this.getVerticalScrollDuration()
                );
            }
        }

        // ----------------------------------------------------------------
        // Horizontal card centering + fallback vertical scroll
        // Runs independently of row-based vertical alignment
        // ----------------------------------------------------------------
        if (options.scroll !== false) {
            const rowItems = element.closest('.row-items');

            if (rowItems) {
                // First: scroll the parent row into view vertically if needed
                // (only if not already handled by row-based scroll above)
                const parentRow = element.closest('.media-row');
                if (parentRow && pageContent && !useRowScroll) {
                    const rowTop = getCumulativeOffsetTop(parentRow, pageContent);
                    const rowHeight = parentRow.offsetHeight;
                    const rowBottom = rowTop + rowHeight;
                    const viewHeight = pageContent.clientHeight;
                    const currentScroll = this.getVerticalScroll(pageContent);
                    const viewBottom = currentScroll + viewHeight;

                    // Check if row is outside viewport with buffers
                    if (
                        rowTop < currentScroll + HORIZONTAL_ROW_VISIBILITY_BUFFER ||
                        rowBottom > viewBottom - HORIZONTAL_ROW_VISIBILITY_BUFFER
                    ) {
                        // Align the row vertically according to user alignment preference
                        const fallbackAlignment = this.getVerticalScrollAlignment();
                        let targetScroll;
                        if (fallbackAlignment === 'bottom') {
                            const offsetBottom =
                                typeof config?.scrollOffsetBottom === 'number'
                                    ? config.scrollOffsetBottom
                                    : DEFAULT_SCROLL_OFFSET_BOTTOM;
                            targetScroll = rowBottom - viewHeight + offsetBottom;
                        } else if (fallbackAlignment === 'top') {
                            targetScroll = rowTop - DEFAULT_SCROLL_OFFSET_TOP;
                        } else {
                            targetScroll = rowTop - viewHeight / 2 + rowHeight / 2;
                        }

                        this.smoothScrollTo(
                            pageContent,
                            Math.max(0, targetScroll),
                            options.instantScroll ? 0 : this.getVerticalScrollDuration()
                        );
                    }
                }

                // Then: center the card horizontally within the row
                const track = rowItems.querySelector('.row-items-track');

                if (track) {
                    const isRtl = document.documentElement.dir === 'rtl';

                    let elementPos;
                    let elementWidth;
                    const containerWidth = rowItems.clientWidth; // Read early before layout dirts
                    let trackWidth;

                    if (track.__virtualRow) {
                        const vIndex = parseInt(element.dataset.virtualIndex || '0', 10);
                        elementPos = track.__virtualRow.getItemPosition(vIndex);

                        // -----------------------------------------------------------------
                        // Mathematical Centering Sync (Expanded Posters)
                        // -----------------------------------------------------------------
                        // Just like in VirtualCardRow.js scrollToIndex(), if we are in
                        // the modern layout and the card can expand, we center it based on
                        // its EXPANDED width (600px). This centers the active expanded poster
                        // cleanly inside the viewport, preventing the right edge from clipping.
                        // -----------------------------------------------------------------
                        const isModern = document.documentElement.getAttribute('data-layout-media-rows') === 'modern';
                        const canExpand =
                            isModern &&
                            !track.__virtualRow.isLandscape &&
                            track.__virtualRow.cardType !== 'square' &&
                            track.__virtualRow.cardType !== 'artist' &&
                            track.__virtualRow.cardType !== 'person';

                        elementWidth = canExpand
                            ? Math.round(600 * (track.__virtualRow.modernMultiplier || 1.0))
                            : track.__virtualRow.itemWidth;
                        trackWidth = track.__virtualRow.getTrackWidth();
                    } else {
                        if (isRtl) {
                            elementPos = parseInt(element.style.right || '0', 10);
                        } else {
                            elementPos = element.offsetLeft;
                        }
                        elementWidth = element.offsetWidth;
                        trackWidth = track.scrollWidth;
                    }

                    // Ideal scroll to center the card
                    const targetScroll = elementPos - containerWidth / 2 + elementWidth / 2;

                    // Clamp to the start and end bounds
                    const maxScroll = Math.max(0, trackWidth - containerWidth);

                    // STABILIZATION: Only trigger horizontal centering if the track is actually
                    // wider than the container. For short rows (e.g. Suggestions with 1-2 items)
                    // that already fit on screen, any translate3d shift is unnecessary and
                    // can cause visible jitter or sub-pixel blurring.
                    if (trackWidth > containerWidth) {
                        const finalScrollLeft = Math.max(0, Math.min(targetScroll, maxScroll));

                        // -------------------------------------------------------------
                        // RESOLVE ACTIVE HORIZONTAL SCROLL ANIMATION MODE
                        // -------------------------------------------------------------
                        // 'gpu': Fast hardware-accelerated CSS translate3d transforms on .row-items-track
                        // 'native': Continuous animated scrolling via container.scrollLeft / smoothScrollTo
                        // 'instant': Immediate position snapping without transition delay
                        // -------------------------------------------------------------
                        const horizontalMode = this.getHorizontalScrollMode();
                        const durationPref = storage.getItem('pref:scrollSmoothingDuration') || 'smooth';
                        const isInstant =
                            options.instantScroll || horizontalMode === 'instant' || durationPref === 'instant';

                        if (horizontalMode === 'native') {
                            // =========================================================
                            // NATIVE TOUCH / OVERFLOW-X SCROLLER MODE
                            // =========================================================
                            // Writes directly to rowItems.scrollLeft. Primarily used on
                            // touch devices (Android mobile/tablets) so D-pad and touch
                            // swipe inertia share the exact same coordinate system.
                            // =========================================================
                            const signedLeft = isRtl ? -finalScrollLeft : finalScrollLeft;
                            if (isInstant) {
                                rowItems.scrollLeft = signedLeft;
                            } else {
                                this.smoothScrollTo(
                                    rowItems,
                                    signedLeft,
                                    this.getHorizontalScrollDuration(),
                                    'horizontal'
                                );
                            }
                        } else if (isInstant) {
                            // =========================================================
                            // INSTANT GPU SNAPSHOT (0ms CSS TRANSFORM)
                            // =========================================================
                            // Reset scrollLeft if previously manipulated in native mode
                            if (rowItems.scrollLeft !== 0) {
                                rowItems.scrollLeft = 0;
                            }

                            // Bypass CSS transitions for instant snap without forced layout reflows
                            const currentTransform = track.style.transform || track.style.webkitTransform || '';
                            const match = currentTransform.match(/translate3d\(\s*-?([\d.]+)(?:px|%)?/);
                            const currentTransformX = match ? parseFloat(match[1]) : 0;
                            const alreadyCentered =
                                Math.abs(currentTransformX - finalScrollLeft) < SCROLL_SNAP_THRESHOLD;

                            if (!alreadyCentered) {
                                track.style.transition = 'none';
                                track.style.webkitTransition = 'none';
                                const transformStr = isRtl
                                    ? `translate3d(${finalScrollLeft}px, 0, 0)`
                                    : `translate3d(-${finalScrollLeft}px, 0, 0)`;
                                track.style.webkitTransform = transformStr;
                                track.style.transform = transformStr;

                                requestAnimationFrame(() => {
                                    track.style.webkitTransition = '';
                                    track.style.transition = '';
                                });
                            }
                        } else {
                            // =========================================================
                            // FAST (GPU ACCELERATED) COMPOSITED TRANSITIONS
                            // =========================================================
                            // Delegates horizontal sliding directly to the GPU compositor via
                            // CSS transform. Bypasses main-thread scrollLeft layout recalculations,
                            // delivering 60 FPS scrolling on Android TV and low-power hardware.
                            // =========================================================
                            if (rowItems.scrollLeft !== 0) {
                                rowItems.scrollLeft = 0;
                            }

                            const currentTransform = track.style.transform || track.style.webkitTransform || '';
                            const match = currentTransform.match(/translate3d\(\s*-?([\d.]+)(?:px|%)?/);
                            const currentTransformX = match ? parseFloat(match[1]) : 0;

                            if (this.getScrollPhysics() !== 'easing') {
                                // =========================================================
                                // SCROLL PHYSICS (GPU COMPOSITED TRACK)
                                // =========================================================
                                // CSS cubic-bezier transitions cannot express a
                                // spring or follower, so the JS integrator drives
                                // per-frame transform writes. The CSS transition
                                // on .row-items-track is disabled while physics
                                // is active (data-scroll-physics on <html>).
                                // =========================================================
                                this._springTrackHorizontal(track, finalScrollLeft, currentTransformX, isRtl);
                            } else if (Math.abs(currentTransformX - finalScrollLeft) >= SCROLL_SNAP_THRESHOLD) {
                                const transformStr = isRtl
                                    ? `translate3d(${finalScrollLeft}px, 0, 0)`
                                    : `translate3d(-${finalScrollLeft}px, 0, 0)`;
                                track.style.webkitTransform = transformStr;
                                track.style.transform = transformStr;
                            }
                        }
                    } else {
                        // Short rows: reset both native scroller and track transform
                        if (rowItems.scrollLeft !== 0) {
                            rowItems.scrollLeft = 0;
                        }
                        track.style.webkitTransform = 'translate3d(0, 0, 0)';
                        track.style.transform = 'translate3d(0, 0, 0)';
                    }
                } else {
                    // Fallback for native horizontal scrolls
                    const elementLeft = element.offsetLeft;
                    const elementWidth = element.offsetWidth;
                    const containerWidth = rowItems.clientWidth;

                    const targetScroll = elementLeft - containerWidth / 2 + elementWidth / 2;
                    const finalScrollLeft = Math.max(0, targetScroll);
                    const horizontalMode = this.getHorizontalScrollMode();
                    const durationPref = storage.getItem('pref:scrollSmoothingDuration') || 'smooth';
                    const isInstant =
                        options.instantScroll || horizontalMode === 'instant' || durationPref === 'instant';

                    this.smoothScrollTo(
                        rowItems,
                        finalScrollLeft,
                        isInstant ? 0 : this.getHorizontalScrollDuration(),
                        'horizontal'
                    );
                }
            } else if (activePageContent) {
                // PERFORMANCE: Skip vertical scroll recalculation for same-row
                // horizontal moves in grids — the element is already in view.
                if (options.skipVerticalScroll) return;

                // Generic vertical scroll-into-view (grids, lists, tall rows)
                const elementTop = getCumulativeOffsetTop(element, activePageContent);
                const viewHeight = activePageContent.clientHeight;
                const currentScroll = this.getVerticalScroll(activePageContent);

                // ================================================================
                // RETARGETING & IN-FLIGHT ANIMATION AWARENESS
                // ================================================================
                // When an animation is actively in flight (native or JS RAF), comparing
                // target coordinates against the volatile mid-flight currentScroll produces
                // false deltas that retrigger animations from mid-flight with zero velocity,
                // causing visual stutter and leaving the focused element off-screen.
                //
                // By evaluating visibility against the active destination target, subsequent
                // keypresses smoothly extend or update the scroll path without hitching.
                // ================================================================
                const activeTarget =
                    this._nativeScrollActive && this._nativeTargetScroll !== null
                        ? this._nativeTargetScroll
                        : this._verticalScrollState
                          ? this._verticalScrollState.target
                          : currentScroll;

                // ============================================================
                // PERF: CACHE ELEMENT HEIGHT PER SECTION
                // ============================================================
                // In grid sections, all cards have the same height. Reading
                // element.offsetHeight forces a synchronous layout reflow on
                // every keypress since the value lives in the layout engine.
                // We cache the first successful read on the config object so
                // subsequent D-pad moves are free integer comparisons.
                // ============================================================
                let elementHeight;
                if (config._cachedCardHeight) {
                    // Re-use the cached value — no layout read needed
                    elementHeight = config._cachedCardHeight;
                } else {
                    // First time: read and cache
                    elementHeight = element.offsetHeight;
                    if (config && elementHeight > 0) {
                        config._cachedCardHeight = elementHeight;
                    }
                }

                // -------------------------------------------------------------
                // VIEWPORT COMFORT MARGINS
                // -------------------------------------------------------------
                // For navigation sidebars (.sidebar-content, .filter-sidebar),
                // 24px top and 32px bottom margins provide optimal breathing room
                // and keep focused buttons comfortably visible away from container edges.
                // For the floating sub-libraries popover, 12px padding keeps items
                // within the popup window bounds. Generic containers use 100px.
                // -------------------------------------------------------------
                const isSidebar =
                    activePageContent.classList.contains('sidebar-content') ||
                    activePageContent.classList.contains('filter-sidebar');
                const isSubLibs = activePageContent.id === 'sidebar-sub-libraries';
                const topMargin = isSidebar ? 24 : isSubLibs ? 12 : GENERIC_SCROLL_MARGIN;
                let bottomMargin = isSidebar ? 32 : isSubLibs ? 12 : GENERIC_SCROLL_MARGIN;

                let finalScrollTop = activeTarget;

                // Apply custom scroll offset from section config
                const customOffset = config?.scrollOffsetTop || 0;
                let effectiveTopMargin = isSidebar || isSubLibs ? topMargin : Math.max(topMargin, customOffset);

                // PREVENT JITTER: If the element and its margins don't completely fit in the viewport
                // together, the top and bottom edge guards will fight each other on every horizontal move.
                // We shrink the margins proportionally to fit.
                if (elementHeight + effectiveTopMargin + bottomMargin > viewHeight) {
                    const availableSpace = Math.max(0, viewHeight - elementHeight);
                    // Distribute available space evenly as maximum allowable margins
                    effectiveTopMargin = Math.min(effectiveTopMargin, availableSpace / 2);
                    bottomMargin = Math.min(bottomMargin, availableSpace / 2);
                }

                // Element cut off at top relative to destination scroll target
                if (elementTop < activeTarget + effectiveTopMargin) {
                    finalScrollTop = Math.max(0, elementTop - effectiveTopMargin);
                }
                // Element cut off at bottom relative to destination scroll target
                else if (elementTop + elementHeight > activeTarget + viewHeight - bottomMargin) {
                    finalScrollTop = Math.max(0, elementTop + elementHeight - viewHeight + bottomMargin);
                }

                // Apply vertical scroll with smooth easing
                const scrollDelta = Math.abs(finalScrollTop - activeTarget);
                if (scrollDelta > SCROLL_SNAP_THRESHOLD) {
                    // PERFORMANCE: Large vertical jumps (e.g. returning to the hero
                    // carousel from a scrolled position) snap instantly to avoid
                    // GPU-induced frame drops on Tizen hardware.
                    const snapEnabled = storage.getItem('pref:snapLargeScrolls') === 'true';
                    const forceInstant = snapEnabled && scrollDelta > viewHeight * LARGE_SCROLL_SNAP_FRACTION;
                    this.smoothScrollTo(
                        activePageContent,
                        finalScrollTop,
                        options.instantScroll || forceInstant ? 0 : this.getVerticalScrollDuration()
                    );
                }
            }
        }
    }

    /**
     * Reset cached DOM references.
     * Should be called when navigating between pages.
     */
    resetCache() {
        // Clear the offsetTop cache so stale row positions don't persist
        // across page navigations (rows on the new page have different offsets).
        this._offsetCache = new WeakMap();
    }
}

// ============================================================================
// Singleton export — one controller shared across the app
// ============================================================================
export const scrollController = new ScrollController();
export default ScrollController;
