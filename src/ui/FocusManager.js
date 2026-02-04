/**
 * ============================================================================
 * Litefin Tizen - FocusManager
 * ============================================================================
 * Manages focus navigation for TV remote D-pad control.
 * Uses robust spatial navigation for grid traversal.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';

// Focusable element selector
// Strictly exclude tabindex="-1" from ALL elements (buttons, inputs, etc.)
const FOCUSABLE_SELECTOR = `
    a[href]:not([tabindex="-1"]),
    button:not([disabled]):not([tabindex="-1"]),
    input:not([disabled]):not([tabindex="-1"]),
    select:not([disabled]):not([tabindex="-1"]),
    textarea:not([disabled]):not([tabindex="-1"]),
    [tabindex]:not([tabindex="-1"])
`.replace(/\s+/g, ' ').trim();

class FocusManager {
    constructor() {
        // Registered sections: name -> config
        this._sections = new Map();

        // Currently active section name
        this._activeSection = null;

        // Focus memory: section -> { element, index }
        this._focusMemory = new Map();

        // PERFORMANCE: Cache focusables per section
        this._focusablesCache = new Map();

        // Currently focused element
        this._focusedElement = null;

        // Focus trap stack (for modals)
        this._trapStack = [];

        // Debounce handling - track PREVIOUS move time for rapid navigation detection
        this._lastMoveTime = 0;
        this._prevMoveTime = 0;

        // SAMSUNG OPTIMIZATION: Cache DOM reference to avoid repeated queries
        this._pageContent = null;

        // Animation state for smooth scrolling (separate for vertical/horizontal)
        this._verticalScrollAnimationId = null;
        this._horizontalScrollAnimationId = null;

        // Bound methods
        // this._onKeyDown = this._onKeyDown.bind(this);

        // Initialize
        this._init();
    }

    /**
     * Cancel ongoing scroll animation
     * @param {string} direction - 'vertical' or 'horizontal'
     * @private
     */
    _cancelScrollAnimation(direction = 'vertical') {
        if (direction === 'vertical') {
            if (this._verticalScrollAnimationId) {
                cancelAnimationFrame(this._verticalScrollAnimationId);
                this._verticalScrollAnimationId = null;
            }
            this._verticalScrollTarget = null;
        } else {
            if (this._horizontalScrollAnimationId) {
                cancelAnimationFrame(this._horizontalScrollAnimationId);
                this._horizontalScrollAnimationId = null;
            }
            this._horizontalScrollTarget = null;
        }
    }

    /**
     * Time-based smooth scroll with easeOutQuad curve
     * Uses a fixed duration animation with proper easing.
     * Retargeting updates target and resets timing from current position.
     * @param {HTMLElement} container - Scroll container element
     * @param {number} targetScroll - Target scroll value
     * @param {number} duration - Animation duration in ms. Default 200ms.
     * @param {string} direction - 'vertical' or 'horizontal'
     * @private
     */
    _smoothScrollTo(container, targetScroll, duration = 200, direction = 'vertical') {
        const isVertical = direction === 'vertical';
        const stateKey = isVertical ? '_verticalScrollState' : '_horizontalScrollState';
        const animIdKey = isVertical ? '_verticalScrollAnimationId' : '_horizontalScrollAnimationId';

        const currentScroll = isVertical ? container.scrollTop : container.scrollLeft;

        // If already at target, do nothing
        if (Math.abs(targetScroll - currentScroll) < 1) {
            if (isVertical) container.scrollTop = targetScroll;
            else container.scrollLeft = targetScroll;
            return;
        }

        // Create/update animation state
        const now = performance.now();
        this[stateKey] = {
            container,
            startScroll: currentScroll,
            target: targetScroll,
            startTime: now,
            duration
        };

        // If animation already running, it will pick up new state
        if (this[animIdKey]) {
            return;
        }

        // easeOutQuad: fast start, smooth deceleration
        const easeOutQuad = t => t * (2 - t);

        const animate = () => {
            const state = this[stateKey];
            if (!state) return;

            const elapsed = performance.now() - state.startTime;
            const progress = Math.min(elapsed / state.duration, 1);
            const eased = easeOutQuad(progress);

            const distance = state.target - state.startScroll;
            const newScroll = state.startScroll + (distance * eased);

            if (isVertical) {
                state.container.scrollTop = newScroll;
            } else {
                state.container.scrollLeft = newScroll;
            }

            if (progress < 1) {
                this[animIdKey] = requestAnimationFrame(animate);
            } else {
                // Ensure we land exactly on target
                if (isVertical) {
                    state.container.scrollTop = state.target;
                } else {
                    state.container.scrollLeft = state.target;
                }
                this[animIdKey] = null;
                this[stateKey] = null;
            }
        };

        this[animIdKey] = requestAnimationFrame(animate);
    }

    /**
     * Initialize focus manager
     * @private
     */
    _init() {
        // Listen for key events from TizenAdapter
        // PREVENT DEFAULT on all handled keys to avoid browser/native double-handling
        eventBus.on('key:up', (e) => { e?.preventDefault(); this._handleKey('up'); });
        eventBus.on('key:down', (e) => { e?.preventDefault(); this._handleKey('down'); });
        eventBus.on('key:left', (e) => { e?.preventDefault(); this._handleKey('left'); });
        eventBus.on('key:right', (e) => { e?.preventDefault(); this._handleKey('right'); });

        eventBus.on('key:enter', (e) => {
            e?.preventDefault(); // Prevent native button click (we trigger it manually)
            this._activate();
        });

        // REMOVED: Direct document keydown listener
        // We now rely solely on TizenAdapter -> EventBus to be the Single Source of Truth.
        // This fixes double-handling issues.

        // Track focus changes globally
        document.addEventListener('focusin', (e) => {
            if (this._focusedElement !== e.target) {
                // If trap is active, check if focus is escaping
                if (this._trapStack.length > 0) {
                    const trapConfig = this._sections.get('__trap__');
                    if (trapConfig && !trapConfig.container.contains(e.target)) {
                        // Focus escaped the trap! Force it back
                        console.warn('FocusManager: Focus escaped trap, forcing back');
                        const focusables = this._getFocusables('__trap__', true);
                        if (focusables.length > 0) {
                            this.focusElement(focusables[0]);
                        }
                        return;
                    }
                }

                this._focusedElement = e.target;

                // Auto-sync active section if the element belongs to one (but not during trap)
                if (this._trapStack.length === 0) {
                    const sectionName = this.getSectionForElement(e.target);
                    if (sectionName && this._activeSection !== sectionName) {
                        this._activeSection = sectionName;
                        eventBus.emit('focus:sectionChanged', sectionName);
                        console.log(`FocusManager: Auto-synced active section to "${sectionName}" via focusin`);
                    }
                }

                this._updateFocusMemory();
            }
        });

        console.log('FocusManager: Initialized (v3 Single Source Rewrite)');
    }

    // REMOVED: _onKeyDown (Redundant)

    /**
     * Handle directional key press
     * @param {string} direction 
     */
    _handleKey(direction) {
        // Simple debounce to prevent event flooding
        const now = Date.now();
        if (now - this._lastMoveTime < 50) return;

        // Track previous move time BEFORE updating current
        // This allows us to detect rapid key holds (moves < 200ms apart)
        this._prevMoveTime = this._lastMoveTime;
        this._lastMoveTime = now;

        this._move(direction);
    }

    /**
     * Register a focusable section
     * @param {string} name - Section identifier
     * @param {HTMLElement} container - Section container element
     * @param {Object} [options] - Section options
     */
    register(name, container, options = {}) {
        const config = {
            container,
            orientation: options.orientation || 'horizontal', // 'horizontal', 'vertical', 'grid'
            loop: options.loop || false,
            // Navigation overrides
            leaveUp: options.leaveUp || null,
            leaveDown: options.leaveDown || null,
            leaveLeft: options.leaveLeft || null,
            leaveRight: options.leaveRight || null,
            // Directional Entry logic
            enterTo: options.enterTo || null, // 'first' or null (spatial/memory)
            // Custom Override
            onMove: options.onMove || null,
            // Custom Scroll Logic
            scrollOffsetTop: options.scrollOffsetTop || 0,
            // Custom selector
            selector: options.selector || FOCUSABLE_SELECTOR
        };

        this._sections.set(name, config);
        this.invalidateCache(name);
        console.log(`FocusManager: Registered section "${name}"`);
    }

    /**
     * Unregister a section
     * @param {string} name 
     */
    unregister(name) {
        this._sections.delete(name);
        this._focusMemory.delete(name);
        // CRITICAL: Clear cache to prevent returning detached elements if section name is reused
        this.invalidateCache(name);

        if (this._activeSection === name) this._activeSection = null;
    }

    /**
     * Clear cached DOM references
     */
    resetDOMCache() {
        this._pageContent = null;
        this._focusablesCache.clear();
    }

    /**
     * Set the active section and focus inside it
     * @param {string} name 
     * @param {boolean} restoreFocus 
     * @param {HTMLElement} [fromElement] - Element user is coming FROM (for spatial entry)
     */
    setActiveSection(name, restoreFocus = true, fromElement = null) {
        if (!this._sections.has(name)) {
            console.warn(`FocusManager: Unknown section "${name}"`);
            return;
        }

        if (this._activeSection && this._activeSection !== name) {
            this._previousSection = this._activeSection;
        }

        this._activeSection = name;
        eventBus.emit('focus:sectionChanged', name);

        if (restoreFocus) {
            this._restoreFocus(name, fromElement);
        }
    }

    getPreviousSection() { return this._previousSection; }

    getActionSection() { return this._activeSection; } // Alias if needed? No, getActiveSection exists.

    /**
     * Get config for a section
     * @param {string} name
     */
    getSectionConfig(name) {
        return this._sections.get(name);
    }

    // Alias for getSectionConfig
    getConfig(name) {
        return this.getSectionConfig(name);
    }

    /**
     * Get focusable elements in section (OPTIMIZED)
     * Uses cache to avoid repeated expensive DOM queries.
     * @param {string} sectionName 
     * @param {boolean} forceRefresh - Force cache refresh
     */
    _getFocusables(sectionName, forceRefresh = false) {
        const config = this._sections.get(sectionName);
        if (!config || !document.contains(config.container)) return [];

        // Return cached if available and not forcing refresh
        if (!forceRefresh && this._focusablesCache.has(sectionName)) {
            return this._focusablesCache.get(sectionName);
        }

        // Query focusables - rely on tabindex for visibility (much faster)
        // Skip expensive getBoundingClientRect checks
        const focusables = Array.from(
            config.container.querySelectorAll(config.selector)
        ).filter(el => el.offsetParent !== null); // Basic visibility check only

        this._focusablesCache.set(sectionName, focusables);
        return focusables;
    }

    /**
     * Invalidate focusables cache for a section
     * @param {string} sectionName 
     */
    invalidateCache(sectionName) {
        if (sectionName) {
            this._focusablesCache.delete(sectionName);
        } else {
            this._focusablesCache.clear();
        }
    }

    /**
     * Core movement logic
     * @param {string} direction 
     */
    _move(direction) {
        if (!this._activeSection) return;

        console.log(`[FocusManager] _move(${direction}) Active: ${this._activeSection}`); // DEBUG LOG

        const config = this._sections.get(this._activeSection);
        if (!config) return;

        // Custom Override Handler
        if (config.onMove) {
            const handled = config.onMove(direction, this._focusedElement);
            if (handled) return; // Handler took care of it (returned true or truthy)
        }

        const focusables = this._getFocusables(this._activeSection);
        if (!focusables.length) return;

        // If nothing focused, focus first available
        if (!this._focusedElement || !config.container.contains(this._focusedElement)) {
            this.focusElement(focusables[0]);
            return;
        }

        const currentIndex = focusables.indexOf(this._focusedElement);
        let nextElement = null;

        // 1. Handling strict orientations
        if (config.orientation === 'horizontal') {
            if (direction === 'left') {
                if (currentIndex > 0) nextElement = focusables[currentIndex - 1];
            } else if (direction === 'right') {
                if (currentIndex < focusables.length - 1) nextElement = focusables[currentIndex + 1];
            }
        }
        else if (config.orientation === 'vertical') {
            if (direction === 'up') {
                if (currentIndex > 0) nextElement = focusables[currentIndex - 1];
            } else if (direction === 'down') {
                if (currentIndex < focusables.length - 1) nextElement = focusables[currentIndex + 1];
            }
        }
        else {
            // 'grid' or default - Use Spatial Navigation
            console.log(`[FocusManager] Spatial Move: ${direction} from`, this._focusedElement);
            nextElement = this._findSpatialNext(this._focusedElement, focusables, direction);
            console.log(`[FocusManager] Spatial Result:`, nextElement);
        }

        // 2. If we found a target, move to it
        if (nextElement) {
            this.focusElement(nextElement);
            // Track timing AFTER focus for next rapid-scroll detection
            this._lastMoveTime = Date.now();
            return;
        }

        console.log(`[FocusManager] No valid target in section. Leaving section: ${direction}`);

        // 3. If no target found inside, try to leave section
        this._leaveSection(direction);
    }

    /**
     * Spatial Navigation: Find best candidate in direction
     * User for ARROW KEY navigation within a grid.
     */
    _findSpatialNext(current, candidates, direction) {
        const rect1 = current.getBoundingClientRect();
        const center1 = {
            x: rect1.left + rect1.width / 2,
            y: rect1.top + rect1.height / 2
        };

        let bestCandidate = null;
        let minScore = Infinity;

        // Filter for candidates in the cone
        for (const candidate of candidates) {
            if (candidate === current) continue;

            const rect2 = candidate.getBoundingClientRect();
            const center2 = {
                x: rect2.left + rect2.width / 2,
                y: rect2.top + rect2.height / 2
            };

            // Calculate vector
            const dx = center2.x - center1.x;
            const dy = center2.y - center1.y;

            // 1. Check Direction
            let isValid = false;
            let distMain = 0;  // parallel to direction
            let distCross = 0; // perpendicular to direction

            // TOLERANCE: Ignore candidates that are "basically on the same line"
            // This prevents Up/Down from selecting items in the SAME ROW due to subpixel jitter
            const THRESHOLD = 10;

            if (direction === 'right') {
                if (dx > THRESHOLD) {
                    isValid = true;
                    distMain = dx;
                    distCross = Math.abs(dy);
                }
            } else if (direction === 'left') {
                if (dx < -THRESHOLD) {
                    isValid = true;
                    distMain = Math.abs(dx);
                    distCross = Math.abs(dy);
                }
            } else if (direction === 'down') {
                if (dy > THRESHOLD) {
                    isValid = true;
                    distMain = dy;
                    distCross = Math.abs(dx);
                }
            } else if (direction === 'up') {
                if (dy < -THRESHOLD) {
                    isValid = true;
                    distMain = Math.abs(dy);
                    distCross = Math.abs(dx);
                }
            }

            if (!isValid) continue;

            // 2. Score with Alignment Bonus
            let overlap = 0;
            if (direction === 'left' || direction === 'right') {
                const top = Math.max(rect1.top, rect2.top);
                const bottom = Math.min(rect1.bottom, rect2.bottom);
                overlap = Math.max(0, bottom - top);
            } else {
                const left = Math.max(rect1.left, rect2.left);
                const right = Math.min(rect1.right, rect2.right);
                overlap = Math.max(0, right - left);
            }

            // If effective overlap, reduce cross penalty
            if (overlap > 0) {
                distCross = 0; // It is "aligned"
            }

            // Calculate final score
            const score = distMain + (distCross * 3.0);

            if (score < minScore) {
                minScore = score;
                bestCandidate = candidate;
            }
        }

        return bestCandidate;
    }

    /**
     * Find best candidate closest to a target element (Euclidean distance).
     * Used for RESTORING focus when entering a section from a specific point.
     */
    _findSpatialClosest(target, candidates) {
        if (!target || !candidates.length) return null;

        const rect1 = target.getBoundingClientRect();
        const center1 = {
            x: rect1.left + rect1.width / 2,
            y: rect1.top + rect1.height / 2
        };

        let best = null;
        let minDist = Infinity;

        for (const c of candidates) {
            const rect2 = c.getBoundingClientRect();
            const center2 = {
                x: rect2.left + rect2.width / 2,
                y: rect2.top + rect2.height / 2
            };
            const dx = center2.x - center1.x;
            const dy = center2.y - center1.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < minDist) {
                minDist = dist;
                best = c;
            }
        }
        return best;
    }

    /**
     * Leave current section (OPTIMIZED)
     * Uses instant scroll when changing sections vertically.
     * @param {string} direction 
     */
    _leaveSection(direction) {
        const config = this._sections.get(this._activeSection);
        if (!config) return;

        const key = `leave${direction.charAt(0).toUpperCase() + direction.slice(1)}`;
        let nextSection = config[key];

        console.log(`[FocusManager] _leaveSection: direction=${direction}, key=${key}, nextSection=${nextSection}, exists=${this._sections.has(nextSection)}`);

        // Keep searching if target section exists but has no focusable elements
        // This handles empty rows in library grids/lists
        const maxSearchDepth = 20; // Prevent infinite loops
        let searchDepth = 0;

        while (nextSection && this._sections.has(nextSection) && searchDepth < maxSearchDepth) {
            const nextConfig = this._sections.get(nextSection);
            const focusables = this._getFocusables(nextSection, true); // Force refresh

            if (focusables && focusables.length > 0) {
                // Found a valid section with focusable elements!
                console.log(`[FocusManager] _leaveSection: Found valid section ${nextSection} with ${focusables.length} focusables`);
                break;
            }

            // Section is empty, try to skip to the next one in the same direction
            console.log(`[FocusManager] _leaveSection: Section ${nextSection} is empty, skipping...`);
            const skipToSection = nextConfig ? nextConfig[key] : null;

            if (!skipToSection || !this._sections.has(skipToSection)) {
                // No more sections to skip to
                nextSection = null;
                break;
            }

            nextSection = skipToSection;
            searchDepth++;
        }

        if (nextSection && this._sections.has(nextSection)) {
            const originElement = this._focusedElement; // Capture for spatial handover

            // Unfocus current
            if (this._focusedElement) {
                this._focusedElement.classList.remove('focused');
            }

            // Set flag for instant scroll when changing rows
            this._useInstantScroll = (direction === 'up' || direction === 'down');

            // Pass originElement to allow selecting closest target in new section
            this.setActiveSection(nextSection, true, originElement);

            this._useInstantScroll = false;
        } else if (direction === 'up') {
            // No section to navigate to (at top of page)
            // Still scroll to top to show full backdrop as visual feedback
            const pageContent = this._focusedElement?.closest('.page-content');
            if (pageContent && pageContent.scrollTop > 0) {
                this._smoothScrollTo(pageContent, 0);
            }
        }
    }

    /**
     * Focus a specific element (OPTIMIZED per Samsung Tizen Guidelines)
     * - Cache DOM queries
     * - Batch reads before writes  
     * - Scroll first, then focus
     */
    focusElement(element, options = {}) {
        if (!element) return;

        const defaults = { scroll: true, skipScroll: false };
        options = { ...defaults, ...options };

        // Cleanup old focus FIRST (lightweight)
        // TIZEN FIX: Explicitly blur the old element to remove native :focus state
        if (this._focusedElement && this._focusedElement !== element) {
            this._focusedElement.classList.remove('focused');
            this._focusedElement.blur(); // Clear native :focus styling on Tizen
        }

        // Get section config for custom scroll offsets
        const sectionName = this.getSectionForElement(element);
        const config = sectionName ? this._sections.get(sectionName) : null;

        // Auto-switch active section if:
        // 1. Element belongs to a section
        // 2. We are not already in that section
        // 3. We are NOT currently in a Trap (Traps manage their own focus)
        if (sectionName && this._activeSection !== sectionName) {
            // Check if we are in a trap (don't switch if we are, unless we're popping)
            const isTrapped = this._trapStack.length > 0 && this._activeSection === '__trap__';

            if (!isTrapped) {
                console.log(`[FocusManager] focusElement: Switching active section from "${this._activeSection}" to "${sectionName}"`);
                this.setActiveSection(sectionName, false); // false = Don't trigger restoreFocus (prevent loop)
            } else {
                console.log(`[FocusManager] focusElement: Staying in trap "${this._activeSection}" despite element belonging to "${sectionName}"`);
            }
        }

        // SAMSUNG OPTIMIZATION: Cache page-content DOM reference
        // RESOLUTION FIX: Find the SPECIFIC page content for this element, not just first in DOM
        // This fixes multi-page DOM issues where querySelector finds hidden pages.
        let pageContent = element.closest('.page-content');

        this._pageContent = pageContent; // Cache for other ops if needed

        // SCROLL FIRST - before focus

        // TIZEN OPTIMIZATION: Use getBoundingClientRect for sub-pixel accuracy 
        // and robustness against floating point offset errors on TV browsers.
        const getCumulativeOffsetTop = (el, relativeTo) => {
            if (!el || !relativeTo) return 0;
            const elRect = el.getBoundingClientRect();
            const relRect = relativeTo.getBoundingClientRect();
            return elRect.top - relRect.top + relativeTo.scrollTop;
        };

        // Determine scroll strategy
        // Row-based scroll should be used if we're in a media row and it's not too tall
        let row = pageContent ? element.closest('.media-row') : null;
        let useRowScroll = !!row;

        if (useRowScroll) {
            // HERO EXCEPTION: Always use row-based scrolling for hero sections
            // to ensure they snap to the standardized top offset (50px).
            const isHero = row.classList.contains('details-main-split');

            if (isHero) {
                // FORCE TOP: For Hero, we want absolute 0, not "aligned to 50px"
                // And we want it always, if we're not at 0.
                if (pageContent.scrollTop > 0) {
                    this._smoothScrollTo(pageContent, 0);
                }
                // Disable standard row logic so it doesn't try to realign
                useRowScroll = false;
                pageContent = null; // Prevent generic vertical scroll override
            }
            // If row is MUCH taller than viewport (e.g. very long list), disable row-alignment
            // to prevent jumping to top when focusing bottom elements.
            else if (row.offsetHeight > pageContent.clientHeight * 2.0) {
                useRowScroll = false;
            }
        }

        if (useRowScroll && row) {
            // For vertical row changes: scroll row section into view
            // SAMSUNG: Batch all reads first
            const rowTop = getCumulativeOffsetTop(row, pageContent);
            const rowHeight = row.offsetHeight;
            const rowBottom = rowTop + rowHeight;

            const viewHeight = pageContent.clientHeight;
            const currentScroll = pageContent.scrollTop;
            const viewBottom = currentScroll + viewHeight;

            // Check visibility with padding/buffer
            // TIZEN: Use a more conservative 40px buffer for cutoffs
            const topCutoff = rowTop < currentScroll + 40;
            const bottomCutoff = rowBottom > viewBottom - 40;

            // If cut off at bottom, scroll down
            if (bottomCutoff) {
                // Aim for top-alignment (the premium look)
                let targetScroll = rowTop - (config.scrollOffsetTop || 50);

                // SAFETY: Ensure the specific focused element is actually visible 
                // at the target scroll position. If the row is very tall, 
                // aligning to top might hide the bottom elements.
                const elTop = getCumulativeOffsetTop(element, pageContent);
                const elBottom = elTop + element.offsetHeight;

                if (elBottom > targetScroll + viewHeight) {
                    // Element is too far down, align element to bottom instead
                    targetScroll = elBottom - viewHeight + 40;
                }

                this._smoothScrollTo(pageContent, Math.max(0, targetScroll));
            }
            // If cut off at top, scroll up
            else if (topCutoff) {
                // SPECIAL CASE: For the Hero section (top of page), ALWAYS scroll to 0
                // This ensures we don't get stuck with a small offset due to margins/padding
                const isHero = row.classList.contains('details-main-split');

                if (isHero) {
                    this._smoothScrollTo(pageContent, 0);
                } else {
                    const padding = config.scrollOffsetTop || 50;
                    let targetScroll = rowTop - padding;

                    // SAFETY: Ensure the element isn't cut off at the top
                    const elTop = getCumulativeOffsetTop(element, pageContent);
                    if (elTop < targetScroll + 20) {
                        targetScroll = elTop - padding;
                    }

                    this._smoothScrollTo(pageContent, Math.max(0, targetScroll));
                }
            }
        }

        // Horizontal Scroll Handling (Run independent of vertical row alignment)
        if (options.scroll) {
            // For horizontal navigation within row
            const rowItems = element.closest('.row-items');
            if (rowItems) {
                // FIRST: Scroll the row into view vertically (if needed)
                // Only do this if we haven't already handled it via useRowScroll
                const row = element.closest('.media-row');
                if (row && pageContent && !useRowScroll) {
                    const rowTop = getCumulativeOffsetTop(row, pageContent);
                    const rowHeight = row.offsetHeight;
                    const rowBottom = rowTop + rowHeight;
                    const viewHeight = pageContent.clientHeight;
                    const currentScroll = pageContent.scrollTop;
                    const viewBottom = currentScroll + viewHeight;

                    // Check if row is outside viewport (with buffers)
                    if (rowTop < currentScroll + 80 || rowBottom > viewBottom - 80) {
                        // Scroll to center the row vertically with smooth easing
                        const targetScroll = rowTop - (viewHeight / 2) + (rowHeight / 2);
                        // Scroll to center the row vertically with smooth easing
                        this._smoothScrollTo(pageContent, Math.max(0, targetScroll));
                    }
                }

                // THEN: Scroll horizontally to center the card
                const elementLeft = element.offsetLeft;
                const elementWidth = element.offsetWidth;
                const containerWidth = rowItems.clientWidth;

                const targetScroll = elementLeft - (containerWidth / 2) + (elementWidth / 2);
                const finalScrollLeft = Math.max(0, targetScroll);

                // RAPID NAVIGATION CHECK:
                // If user is holding button (machine gun < 100ms), use instant scroll
                // Otherwise use smooth scroll with easing for premium feel
                // Always use smooth scroll for premium feel, even during rapid navigation
                this._smoothScrollTo(rowItems, finalScrollLeft, 150, 'horizontal');
            } else if (pageContent) {
                // Generic Vertical Scroll (for Grids/Lists or Tall Rows)
                const elementTop = getCumulativeOffsetTop(element, pageContent);
                const elementHeight = element.offsetHeight;
                const viewHeight = pageContent.clientHeight;
                const currentScroll = pageContent.scrollTop;

                // Margins for visibility comfort
                const topMargin = 100; // Increased
                const bottomMargin = 100; // Increased

                let finalScrollTop = currentScroll;

                // Simple "Scroll Into View" logic
                const customOffset = config?.scrollOffsetTop || 0;
                const effectiveTopMargin = Math.max(topMargin, customOffset);

                if (elementTop < currentScroll + effectiveTopMargin) {
                    finalScrollTop = Math.max(0, elementTop - effectiveTopMargin);
                }
                else if (elementTop + elementHeight > currentScroll + viewHeight - bottomMargin) {
                    if (elementHeight < viewHeight / 3) {
                        finalScrollTop = elementTop - (viewHeight / 2) + (elementHeight / 2);
                    } else {
                        finalScrollTop = elementTop + elementHeight - viewHeight + bottomMargin;
                    }
                }

                // Apply Vertical Scroll with smooth easing
                if (finalScrollTop !== currentScroll) {
                    // Always use Premium "Weighty" Animation
                    this._smoothScrollTo(pageContent, finalScrollTop);
                }
            }
        }

        // NOW set focus (after scroll is done)
        this._focusedElement = element;

        // NOW modify the DOM (Dirty the layout)
        this._focusedElement.classList.add('focused');

        // NATIVE FOCUS DISABLED: eliminates scroll rebounding/fighting on Tizen
        // FocusManager handles all input internally via EventBus.
        // this._focusedElement.focus({ preventScroll: true });

        this._updateFocusMemory();
        eventBus.emit('focus:changed', element);
    }

    _updateFocusMemory() {
        if (!this._activeSection || !this._focusedElement) return;
        const config = this._sections.get(this._activeSection);

        if (config.container.contains(this._focusedElement)) {
            const focusables = this._getFocusables(this._activeSection);
            const index = focusables.indexOf(this._focusedElement);
            this._focusMemory.set(this._activeSection, {
                element: this._focusedElement,
                index
            });
        }
    }

    _restoreFocus(sectionName, fromElement = null) {
        const config = this._sections.get(sectionName);
        if (!config) return;

        const memory = this._focusMemory.get(sectionName);
        const focusables = this._getFocusables(sectionName);
        if (!focusables.length) return;

        // Sidebar always starts at Home when entered
        if (sectionName === 'sidebar') {
            // Try to find Home button first
            const homeBtn = focusables.find(el => el.id === 'sidebar-home');
            const target = homeBtn || focusables[0];

            this.focusElement(target, { skipScroll: true });
            return;
        }

        let target = null;

        // 0. Forced Entry Logic (Highest Priority)
        // Support 'first' or 'active-element' (finds .active or .selected)
        if (config.enterTo === 'first' && focusables.length > 0) {
            target = focusables[0];
            this.focusElement(target, { skipScroll: this._useInstantScroll });
            return;
        }
        else if (config.enterTo === 'active-element' && focusables.length > 0) {
            target = focusables.find(el => el.classList.contains('active') || el.classList.contains('selected')) || focusables[0];
            this.focusElement(target, { skipScroll: this._useInstantScroll });
            return;
        }

        // 1. Spatial Entry
        // If we came from another element (e.g. Button below grid), pick closest grid item
        if (fromElement && document.contains(fromElement)) {
            target = this._findSpatialClosest(fromElement, focusables);
        }

        // 2. Memory (Fallback)
        if (!target && memory) {
            // Try exact element
            if (document.contains(memory.element) && focusables.includes(memory.element)) {
                target = memory.element;
            }
            // Try index
            else if (memory.index >= 0 && memory.index < focusables.length) {
                target = focusables[memory.index];
            }
        }

        // 3. Default (First Item)
        if (!target) {
            target = focusables[0];
        }

        // Use skipScroll when changing sections vertically (much faster)
        this.focusElement(target, { skipScroll: this._useInstantScroll });
    }

    _activate() {
        if (this._focusedElement) {
            // Dispatch click
            this._focusedElement.click();
            eventBus.emit('focus:activated', this._focusedElement);
        }
    }

    pushTrap(container, options = {}) {
        this._trapStack.push({
            section: this._activeSection,
            element: this._focusedElement
        });
        this.register('__trap__', container, {
            orientation: options.orientation || 'grid',
            selector: options.selector || undefined,
            // Explicitly block all leaving directions
            leaveUp: null,
            leaveDown: null,
            leaveLeft: null,
            leaveRight: null
        });
        this.setActiveSection('__trap__');
    }

    popTrap() {
        const prev = this._trapStack.pop();
        this.unregister('__trap__');
        if (prev) {
            this.setActiveSection(prev.section, false);
            if (prev.element && document.contains(prev.element)) {
                this.focusElement(prev.element);
            }
        }
    }

    getActiveSection() { return this._activeSection; }
    getFocused() { return this._focusedElement; }

    /**
     * Find the registered section name that contains the element
     * @param {HTMLElement} element 
     */
    getSectionForElement(element) {
        if (!element) return null;
        for (const [name, config] of this._sections.entries()) {
            if (config.container.contains(element)) {
                return name;
            }
        }
        return null;
    }

    destroy() {
        // document.removeEventListener('keydown', this._onKeyDown);
        this._sections.clear();
        this._focusMemory.clear();
    }
}

export const focusManager = new FocusManager();
export default FocusManager;
