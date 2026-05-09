/**
 * ============================================================================
 * Litefin Tizen - FocusManager
 * ============================================================================
 * Manages focus navigation for TV remote D-pad control.
 * Uses robust spatial navigation for grid traversal.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { logger } from '../utils/Logger.js';
import { spatialNavigator } from './SpatialNavigator.js';
import { scrollController } from './ScrollController.js';
import { storage } from '../utils/StorageService.js';

const log = logger.create('FocusManager');

// Focusable element selector
// Strictly exclude tabindex="-1" from ALL elements (buttons, inputs, etc.)
const FOCUSABLE_SELECTOR = `
    a[href]:not([tabindex="-1"]),
    button:not([disabled]):not([tabindex="-1"]),
    input:not([disabled]):not([tabindex="-1"]),
    select:not([disabled]):not([tabindex="-1"]),
    textarea:not([disabled]):not([tabindex="-1"]),
    [tabindex]:not([tabindex="-1"])
`
    .replace(/\s+/g, ' ')
    .trim();

// ============================================================================
// Constants
// ============================================================================

// Minimum time (ms) between key events to prevent event flooding.
// Keypresses faster than this interval are dropped.
const KEY_DEBOUNCE_MS = 40;

// Maximum number of empty sections to skip through when leaving a section.
// Prevents infinite loops if section linking is misconfigured.
const MAX_SECTION_SKIP_DEPTH = 20;

// Rapid navigation (instant scroll) threshold.
// If consecutive keypresses are faster than this, we snap to avoid scroll queueing.
const RAPID_MOVE_THRESHOLD_MS = 120;

// Minimum number of consecutive rapid moves before instant scroll kicks in.
// Ensures a single fast double-tap doesn't cause a snap.
const RAPID_MOVE_STREAK_REQUIRED = 2;

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
        this._rapidMoveStreak = 0;

        // Suspended flag — when true, all key processing is skipped.
        // Used by components that manage their own focus (e.g. PlayerOSD)
        this._suspended = false;

        // Delegated utilities (extracted from this God Object)
        this._spatial = spatialNavigator;
        this._scroll = scrollController;

        // Initialize
        this._init();
    }

    // _cancelScrollAnimation → moved to ScrollController
    // _smoothScrollTo → moved to ScrollController

    /**
     * Initialize focus manager
     * @private
     */
    _init() {
        // Listen for key events from TizenAdapter
        // PREVENT DEFAULT on all handled keys to avoid browser/native double-handling
        eventBus.on('key:up', (e) => {
            if (this._suspended) return;
            e?.preventDefault();
            this._handleKey('up');
        });
        eventBus.on('key:down', (e) => {
            if (this._suspended) return;
            e?.preventDefault();
            this._handleKey('down');
        });
        eventBus.on('key:left', (e) => {
            if (this._suspended) return;
            e?.preventDefault();
            this._handleKey('left');
        });
        eventBus.on('key:right', (e) => {
            if (this._suspended) return;
            e?.preventDefault();
            this._handleKey('right');
        });

        let lastMouseDownTime = 0;

        document.addEventListener(
            'mousedown',
            () => {
                lastMouseDownTime = Date.now();
            },
            { capture: true, passive: true }
        );

        eventBus.on('key:enter', (e) => {
            if (this._suspended) return;

            // Magic Remote cursor clicks generate a synthetic 'Enter' keydown
            // immediately after 'mousedown'. If we intercept it, we break the native
            // mouse click sequence and trigger the wrong focused element.
            // By ignoring Enter keys right after a mousedown, the cursor acts exactly like a real mouse.
            if (Date.now() - lastMouseDownTime < 500) {
                return;
            }

            e?.preventDefault(); // Prevent native button click (we trigger it manually for D-pad)
            this._activate();
        });

        // REMOVED: Direct document keydown listener
        // We now rely solely on TizenAdapter -> EventBus to be the Single Source of Truth.
        // This fixes double-handling issues.

        // Track focus changes globally
        document.addEventListener('focusin', (e) => {
            if (this._focusedElement !== e.target) {
                this._handleFocusChange(e.target);
            }
        });

        // REMOVED: Proactive mousedown focus sync.
        // It caused layout shifts and blur() calls during the click sequence,
        // which caused TV browsers to cancel the click event (the "not opening" bug).
        // Magic Remote is now handled purely as a native mouse via the Enter bypass above.

        // MAGIC CURSOR: Wheel Navigation
        // Allows scrolling the Magic Remote wheel to navigate vertically between rows/items.
        document.addEventListener(
            'wheel',
            (e) => {
                if (this._suspended) return;

                // Respect the user setting (default to false)
                if (storage.getItem('pref:hoverScrollNavigation') !== 'true') return;

                // Ignore if player is active or OSD is focused (PlayerOSD handles its own wheel behavior)
                if (
                    document.body.classList.contains('player-active') ||
                    this.activeSection === 'osd' ||
                    this.activeSection === 'player' ||
                    this._activeSection === 'sidebar' ||
                    document.querySelector('.sidebar.expanded') ||
                    document.querySelector('.sidebar:hover') ||
                    (this._activeSection && this._activeSection.startsWith('settings-'))
                )
                    return;

                // Threshold to prevent accidental jitter moves (Magic Remotes are sensitive)
                if (Math.abs(e.deltaY) < 30) return;

                const direction = e.deltaY > 0 ? 'down' : 'up';
                this._handleKey(direction);
            },
            { passive: true }
        );

        log.info('Initialized (v3 Single Source Rewrite)');
    }

    /**
     * Internal logic for handling a focus change to a new element.
     * @param {HTMLElement} target - The element receiving focus
     * @private
     */
    _handleFocusChange(target) {
        // If trap is active, check if focus is escaping
        if (this._trapStack.length > 0) {
            const trapConfig = this._sections.get('__trap__');
            if (trapConfig && !trapConfig.container.contains(target)) {
                // Focus escaped the trap! Force it back
                log.warn('Focus escaped trap, forcing back');
                const focusables = this._getFocusables('__trap__', true);
                if (focusables.length > 0) {
                    this.focusElement(focusables[0]);
                }
                return;
            }
        }

        // Explicitly remove .focused class from the previous element
        if (this._focusedElement) {
            this._focusedElement.classList.remove('focused');

            // Remove generic .focused-row from parent settings items if applicable
            const oldSettingItem = this._focusedElement.closest('.setting-item');
            if (oldSettingItem) {
                oldSettingItem.classList.remove('focused-row');
            }
        }

        this._focusedElement = target;

        // Add .focused to the new element so focus styling applies correctly
        if (this._focusedElement) {
            this._focusedElement.classList.add('focused');

            // Add generic .focused-row to parent settings items to highlight the whole row
            const newSettingItem = this._focusedElement.closest('.setting-item');
            if (newSettingItem) {
                newSettingItem.classList.add('focused-row');
            }
        }

        // Auto-sync active section if the element belongs to one (but not during trap)
        if (this._trapStack.length === 0) {
            const sectionName = this.getSectionForElement(target);
            if (sectionName && this._activeSection !== sectionName) {
                if (this._activeSection) {
                    this._previousSection = this._activeSection;
                }
                this._activeSection = sectionName;
                eventBus.emit('focus:sectionChanged', sectionName);
                log.debug(`Auto-synced active section to "${sectionName}" via focusin`);
            }
        }

        this._updateFocusMemory();
    }

    // REMOVED: _onKeyDown (Redundant)

    /**
     * Handle directional key press
     * @param {string} direction
     */
    _handleKey(direction) {
        // Simple debounce to prevent event flooding
        const now = Date.now();
        if (now - this._lastMoveTime < KEY_DEBOUNCE_MS) return;

        // Track previous move time BEFORE updating current
        // This allows us to detect rapid key holds
        const gap = now - this._lastMoveTime;
        const isRapidGap = this._lastMoveTime > 0 && gap < RAPID_MOVE_THRESHOLD_MS;

        this._prevMoveTime = this._lastMoveTime;
        this._lastMoveTime = now;

        // Update rapid move streak
        if (isRapidGap && this._lastMoveDirection === direction) {
            this._rapidMoveStreak++;
        } else {
            this._rapidMoveStreak = 0;
            this._lastMoveDirection = direction;
        }

        // SLIDER HANDLING: When a range input is focused, Left/Right keys
        // should adjust the slider value instead of navigating to other elements.
        // On TV remotes, arrow keys are intercepted by FocusManager before
        // the native <input type="range"> can process them.
        if ((direction === 'left' || direction === 'right') && this._focusedElement) {
            const el = this._focusedElement;
            if (el.tagName === 'INPUT' && el.type === 'range') {
                const step = parseFloat(el.step) || 1;
                const min = parseFloat(el.min) || 0;
                const max = parseFloat(el.max) || 100;
                let value = parseFloat(el.value) || 0;

                // Detect if the slider is rendered in RTL mode
                let isRTL = document.documentElement.dir === 'rtl';
                if (window.getComputedStyle) {
                    isRTL = window.getComputedStyle(el).direction === 'rtl';
                }

                // In RTL, min is on the right and max is on the left visually.
                // Pressing Left should increase value (move towards max).
                let effectiveDirection = direction;
                if (isRTL) {
                    effectiveDirection = direction === 'left' ? 'right' : 'left';
                }

                // Adjust value based on effective direction
                if (effectiveDirection === 'right') {
                    value = Math.min(max, value + step);
                } else {
                    value = Math.max(min, value - step);
                }

                // Apply the new value and fire the input event
                // so that any listeners (e.g. SettingsPage._bindSliderEvents) react
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return; // Don't navigate, we handled it
            }
        }

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
            onEnter: options.onEnter || null,
            onRestoreIndex: options.onRestoreIndex || null,
            // Custom Scroll Logic
            scrollOffsetTop: options.scrollOffsetTop || 0,
            // CSS selector for the default element to focus when entering the section.
            // If provided, overrides spatial/memory entry logic.
            // Example: '#sidebar-home' to always land on the Home button.
            defaultFocusSelector: options.defaultFocusSelector || null,
            // Custom selector
            selector: options.selector || FOCUSABLE_SELECTOR
        };

        this._sections.set(name, config);
        this.invalidateCache(name);

        // PERFORMANCE: Tag the container with its section name so getSectionForElement
        // can use a single O(1) closest() DOM lookup instead of looping all sections.
        // The attribute is removed in unregister() to keep the DOM clean.
        container.dataset.fmSection = name;

        log.debug(`Registered section "${name}"`);
    }

    /**
     * Unregister a section
     * @param {string} name
     */
    unregister(name) {
        // If the focused element is in this section, clear it before removing the config
        if (this._focusedElement) {
            const section = this.getSectionForElement(this._focusedElement);
            if (section === name) {
                this.clearFocus();
            }
        }

        // PERFORMANCE: Remove the data-fm-section tag we set in register()
        // so the container is clean and doesn't confuse future closest() calls.
        const config = this._sections.get(name);
        if (config && config.container && config.container.dataset) {
            delete config.container.dataset.fmSection;
        }

        this._sections.delete(name);
        this._focusMemory.delete(name);
        // CRITICAL: Clear cache to prevent returning detached elements if section name is reused
        this.invalidateCache(name);

        if (this._activeSection === name) this._activeSection = null;
    }

    /**
     * Explicitly remove focus from the current element.
     * Use this when a page is being destroyed or a section is removed.
     */
    clearFocus() {
        if (this._focusedElement) {
            this._focusedElement.classList.remove('focused');

            // Remove generic .focused-row from parent settings items
            const oldSettingItem = this._focusedElement.closest('.setting-item');
            if (oldSettingItem) {
                oldSettingItem.classList.remove('focused-row');
            }

            this._focusedElement.blur();
            this._focusedElement = null;
            log.debug('Focus cleared');
        }
    }

    /**
     * Clear cached DOM references
     */
    resetDOMCache() {
        this._focusablesCache.clear();
        this._scroll.resetCache();
    }

    /**
     * Set the active section and focus inside it
     * @param {string} name
     * @param {boolean} restoreFocus
     * @param {HTMLElement} [fromElement] - Element user is coming FROM (for spatial entry)
     */
    setActiveSection(name, restoreFocus = true, fromElement = null, options = {}) {
        if (!this._sections.has(name)) {
            log.warn(`Unknown section "${name}"`);
            return;
        }

        if (this._activeSection && this._activeSection !== name) {
            this._previousSection = this._activeSection;
        }

        this._activeSection = name;
        eventBus.emit('focus:sectionChanged', name);

        if (restoreFocus) {
            this._restoreFocus(name, fromElement, options);
        }
    }

    getPreviousSection() {
        return this._previousSection;
    }

    getActionSection() {
        return this._activeSection;
    } // Alias if needed? No, getActiveSection exists.

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

        // Query focusables and filter out hidden elements.
        // TIZEN OPTIMIZATION: We ONLY check non-reflowing style properties
        // to avoid synchronous layout thrashing loops which freeze TV hardware.
        // Previously we checked offsetParent and getComputedStyle, which force recalcs.
        const allElements = Array.from(config.container.querySelectorAll(config.selector));

        const focusables = [];
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];

            // Fast, non-reflowing checks to determine visibility.
            // NOTE: We assume elements are visible rather than invisible natively,
            // as virtualized elements manage visibility via their mount lifecycle.
            if (el.style.display === 'none') continue;
            if (el.classList.contains('hidden')) continue;
            if (el.hasAttribute('hidden')) continue;

            // Check if any parent element is marked as hidden (avoids offsetParent reflow)
            // Tizen DOM allows fast closest() queries without layout thrashing
            if (el.closest('.hidden') || el.closest('[hidden]')) continue;

            // Inline styles for display: none on parents
            if (el.closest('[style*="display: none"]') || el.closest('[style*="display:none"]')) continue;

            focusables.push(el);
        }

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

        // log.debug(`_move(${direction}) Active: ${this._activeSection}`); // DEBUG LOG

        const config = this._sections.get(this._activeSection);
        if (!config) return;

        // Custom Override Handler
        if (config.onMove) {
            // Pass the currently focused element as the second argument.
            const handled = config.onMove(direction, this._focusedElement);
            if (handled) return; // Handler took care of it (returned true or truthy)
        }

        const focusables = this._getFocusables(this._activeSection);

        // If the section is completely empty, immediately try to leave it
        if (!focusables.length) {
            this._leaveSection(direction);
            return;
        }

        // If nothing focused, focus first available
        if (!this._focusedElement || !config.container.contains(this._focusedElement)) {
            this.focusElement(focusables[0]);
            return;
        }

        const currentIndex = focusables.indexOf(this._focusedElement);
        let nextElement = null;

        // 1. Handling strict orientations
        if (config.orientation === 'horizontal') {
            const isRtl = document.documentElement.dir === 'rtl';
            let logicalDirection = direction;
            if (isRtl) {
                if (direction === 'left') logicalDirection = 'right';
                else if (direction === 'right') logicalDirection = 'left';
            }

            if (logicalDirection === 'left') {
                if (currentIndex > 0) nextElement = focusables[currentIndex - 1];
            } else if (logicalDirection === 'right') {
                if (currentIndex < focusables.length - 1) nextElement = focusables[currentIndex + 1];
            }
        } else if (config.orientation === 'vertical') {
            if (direction === 'up') {
                if (currentIndex > 0) nextElement = focusables[currentIndex - 1];
            } else if (direction === 'down') {
                if (currentIndex < focusables.length - 1) nextElement = focusables[currentIndex + 1];
            }
        } else {
            // 'grid' or default — delegate to SpatialNavigator
            nextElement = this._spatial.findNext(this._focusedElement, focusables, direction);
        }

        // 2. If we found a target, move to it
        if (nextElement) {
            // ----------------------------------------------------------------
            // RAPID NAVIGATION MODE
            // If the user is holding a key (streak of keypresses < 150ms
            // apart), disable the smooth scroll animation and snap instantly.
            // This prevents the scroll queue from building up behind held keys,
            // which causes the page to keep scrolling after the user stops.
            // ----------------------------------------------------------------
            const isRapidNav = this._rapidMoveStreak >= RAPID_MOVE_STREAK_REQUIRED;

            this.focusElement(nextElement, { instantScroll: isRapidNav });
            return;
        }

        log.debug(`No valid target in section. Leaving section: ${direction}`);

        // 3. If no target found inside, try to leave section
        this._leaveSection(direction);
    }

    // _findSpatialNext → moved to SpatialNavigator
    // _findSpatialClosest → moved to SpatialNavigator

    /**
     * Leave current section (OPTIMIZED)
     * Uses instant scroll when changing sections vertically.
     * @param {string} direction
     */
    _leaveSection(direction) {
        const config = this._sections.get(this._activeSection);
        if (!config) return;

        const isRtl = document.documentElement.dir === 'rtl';
        let leaveDirection = direction;
        if (isRtl) {
            if (direction === 'left') leaveDirection = 'right';
            else if (direction === 'right') leaveDirection = 'left';
        }

        const key = `leave${leaveDirection.charAt(0).toUpperCase() + leaveDirection.slice(1)}`;
        let nextSection = config[key];

        log.debug(`_leaveSection: direction=${direction}, key=${key}, nextSection=${nextSection}`);

        // Keep searching if target section exists but has no focusable elements
        // This handles empty rows in library grids/lists
        const maxSearchDepth = MAX_SECTION_SKIP_DEPTH;
        let searchDepth = 0;

        // PERFORMANCE: Track which sections we've already queried in this skip loop
        // to avoid calling _getFocusables(forceRefresh=true) on the same section twice.
        const checkedSections = new Set();

        while (nextSection && this._sections.has(nextSection) && searchDepth < maxSearchDepth) {
            const nextConfig = this._sections.get(nextSection);

            // PERFORMANCE: Never force refresh during skip loops to avoid querySelectorAll
            // and visibility check overhead per row. Caches are invalidated externally
            // when needed (e.g. by VirtualCardRow).
            checkedSections.add(nextSection);

            const focusables = this._getFocusables(nextSection, false);

            if (focusables && focusables.length > 0) {
                // Found a valid section with focusable elements!
                // log.debug(
                //    `_leaveSection: Found valid section ${nextSection} with ${focusables.length} focusables`
                // );
                break;
            }

            // Section is empty, try to skip to the next one in the same direction
            // log.debug(`_leaveSection: Section ${nextSection} is empty, skipping...`);
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

                // Remove generic .focused-row from parent settings items
                const oldSettingItem = this._focusedElement.closest('.setting-item');
                if (oldSettingItem) {
                    oldSettingItem.classList.remove('focused-row');
                }
            }

            // Detect rapid navigation: use the SAME streak-based check as _move() so
            // that single deliberate D-pad presses always get the smooth 200ms animation.
            //
            // The old check (gap < 200ms between last 2 presses) fired on virtually every
            // cross-section transition, because a horizontal nav press followed by a
            // vertical exit press is naturally within 200ms — making rows always snap
            // instead of slide, regardless of intent.
            //
            // The streak check requires RAPID_MOVE_STREAK_REQUIRED (2) consecutive fast
            // presses before enabling instant scroll, which only triggers when the user
            // is genuinely holding the key — producing the correct snapping behaviour
            // for held keys and smooth animation for single taps.
            const isRapidNav = this._rapidMoveStreak >= RAPID_MOVE_STREAK_REQUIRED;

            // Pass originElement to allow selecting closest target in new section
            this.setActiveSection(nextSection, true, originElement, { direction, instantScroll: isRapidNav });
        } else if (direction === 'up') {
            // No section to navigate to (at top of page)
            // Still scroll to top to show full backdrop as visual feedback
            const scrollContainer = this._scroll.getScrollContainer(this._focusedElement);
            if (scrollContainer && scrollContainer.scrollTop > 0) {
                this._scroll.smoothScrollTo(scrollContainer, 0);
            }
        }
    }

    // _getScrollContainer → moved to ScrollController

    /**
     * Focus a specific element (OPTIMIZED per Samsung Tizen Guidelines)
     * Coordinates cleanup, section switching, scroll delegation, and focus.
     */
    focusElement(element, options = {}) {
        if (!element) return;

        const defaults = { scroll: true, skipScroll: false, instantScroll: false };
        options = { ...defaults, ...options };

        // Cleanup old focus FIRST (lightweight)
        // TIZEN FIX: Explicitly blur the old element to remove native :focus state
        if (this._focusedElement && this._focusedElement !== element) {
            this._focusedElement.classList.remove('focused');

            // Remove generic .focused-row from parent settings items
            const oldSettingItem = this._focusedElement.closest('.setting-item');
            if (oldSettingItem) {
                oldSettingItem.classList.remove('focused-row');
            }

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
                log.debug(`focusElement: Switching active section from "${this._activeSection}" to "${sectionName}"`);
                this.setActiveSection(sectionName, false); // false = Don't trigger restoreFocus (prevent loop)
            } else {
                log.debug(
                    `focusElement: Staying in trap "${this._activeSection}" despite element belonging to "${sectionName}"`
                );
            }
        }

        // Delegate scroll positioning to ScrollController
        // Passes section config for custom offsets (scrollOffsetTop, etc.)
        this._scroll.scrollIntoView(element, config || {}, options);

        // NOW set focus (after scroll is done)
        this._focusedElement = element;

        // NOW modify the DOM (Dirty the layout)
        this._focusedElement.classList.add('focused');

        // Add generic .focused-row to parent settings items to highlight the whole row
        const newSettingItem = this._focusedElement.closest('.setting-item');
        if (newSettingItem) {
            newSettingItem.classList.add('focused-row');
        }

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
                index,
                virtualIndex:
                    this._focusedElement.dataset.virtualIndex !== undefined
                        ? parseInt(this._focusedElement.dataset.virtualIndex, 10)
                        : undefined
            });
        }
    }

    _restoreFocus(sectionName, fromElement = null, options = {}) {
        const config = this._sections.get(sectionName);
        if (!config) return;

        const focusables = this._getFocusables(sectionName);
        const memory = this._focusMemory.get(sectionName);

        if (!focusables.length) {
            if (options.direction) {
                // If we entered this empty section via a directional move, continue propagating
                this._leaveSection(options.direction);
            }
            return;
        }

        // 0. Default Focus Selector (config-driven, replaces hardcoded section checks)
        // If a section specifies defaultFocusSelector, always focus that element on entry.
        // Example: sidebar uses '#sidebar-home' to always land on Home.
        if (config.defaultFocusSelector) {
            const defaultEl = focusables.find((el) => el.matches(config.defaultFocusSelector));
            const target = defaultEl || focusables[0];
            this.focusElement(target, { skipScroll: true });
            return;
        }

        let target = null;

        // 1. Forced Entry Logic (Highest Priority)
        // Support 'first' or 'active-element' (finds .active or .selected)
        const enterTo = options.enterTo || config.enterTo;

        // VIRTUALIZED SUPPORT: Let sections intercept spatial entry directly
        // Because DOM nodes are recycled, we cannot rely on scraping raw DOM
        if (typeof config.onEnter === 'function') {
            const hookTarget = config.onEnter(fromElement, options);
            if (hookTarget) {
                // Forward instantScroll so the scroll controller respects rapid-nav speed.
                // Previously this wrongly converted instantScroll into skipScroll,
                // which is a completely different option — that bug caused every row
                // transition to always animate at full 200ms regardless of key-hold speed.
                this.focusElement(hookTarget, { instantScroll: !!options.instantScroll });
                return;
            }
        }

        if (enterTo === 'first' && focusables.length > 0) {
            target = focusables[0];
            this.focusElement(target, { instantScroll: !!options.instantScroll });
            return;
        } else if (enterTo === 'active-element' && focusables.length > 0) {
            target =
                focusables.find((el) => el.classList.contains('active') || el.classList.contains('selected')) ||
                focusables[0];
            this.focusElement(target, { instantScroll: !!options.instantScroll });
            return;
        }

        // 2. Spatial Entry
        // If we came from another element (e.g. Button below grid), pick closest grid item
        // Note: Handled above via onEnter hook for virtual rows
        if (fromElement && document.contains(fromElement) && typeof config.onEnter !== 'function') {
            target = this._spatial.findClosest(fromElement, focusables);
        }

        // 3. Memory (Fallback)
        if (!target && memory) {
            // Virtualized memory
            if (memory.virtualIndex !== undefined && typeof config.onRestoreIndex === 'function') {
                target = config.onRestoreIndex(memory.virtualIndex);
            }
            // Try exact element
            else if (document.contains(memory.element) && focusables.includes(memory.element)) {
                target = memory.element;
            }
            // Try index
            else if (memory.index >= 0 && memory.index < focusables.length) {
                target = focusables[memory.index];
            }
        }

        // 4. Default (First Item)
        if (!target) {
            target = focusables[0];
        }

        // Forward instantScroll speed correctly to the scroll controller.
        // 'skipScroll' was previously being computed here but was the wrong option —
        // scrollIntoView uses 'instantScroll' for animation duration, not 'skipScroll'.
        this.focusElement(target, { instantScroll: !!options.instantScroll });
    }

    _activate() {
        if (this._suspended) return;
        if (this._focusedElement) {
            // Dispatch click
            this._focusedElement.click();
            eventBus.emit('focus:activated', this._focusedElement);
        }
    }

    // ========================================================================
    // Suspend / Resume
    // ========================================================================

    /**
     * Suspend all key event processing.
     * Used by components that manage their own focus (e.g. PlayerOSD)
     * to prevent FocusManager from double-handling key events.
     */
    suspend() {
        this._suspended = true;
        log.info('Key processing suspended');
    }

    /**
     * Resume key event processing after a prior suspend() call.
     */
    resume() {
        this._suspended = false;
        log.info('Key processing resumed');
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

    getActiveSection() {
        return this._activeSection;
    }
    getFocused() {
        return this._focusedElement;
    }

    /**
     * Find the registered section name that contains the element.
     *
     * PERFORMANCE: Uses a two-stage lookup:
     * 1. O(1) closest('[data-fm-section]') DOM traversal — sections tag their
     *    containers with this attribute in register(). This is almost always
     *    sufficient and avoids looping all sections on every focusin event.
     * 2. O(n) linear fallback for edge cases where closest() can't find the tag
     *    (e.g. __trap__ containers injected without going through register's tagging).
     *
     * @param {HTMLElement} element
     */
    getSectionForElement(element) {
        if (!element) return null;

        // Fast path: walk up the DOM to find the nearest section container.
        // This replaces the old O(n) linear sections scan for the vast majority of calls.
        const sectionContainer = element.closest('[data-fm-section]');
        if (sectionContainer) {
            const name = sectionContainer.dataset.fmSection;
            // Verify the section is still registered (not just a stale attribute)
            if (this._sections.has(name)) {
                return name;
            }
        }

        // Fallback: linear scan — only needed when closest() fails (e.g. portals,
        // fixed position containers, or sections registered before the attribute patch).
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
