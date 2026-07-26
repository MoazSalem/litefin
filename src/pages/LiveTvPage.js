/**
 * ============================================================================
 * Litefin Tizen - Live TV Page
 * ============================================================================
 * Main entry point for Live TV. Handles tabs for:
 * - On Now (Suggestions)
 * - Guide (EPG)
 * - Channels
 * - Recordings
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import MediaGrid from '../components/MediaGrid.js';
import EpgGrid from '../components/EpgGrid.js';
import CardRenderer from '../utils/CardRenderer.js';
import { storage } from '../utils/StorageService.js';
import { router } from '../core/Router.js';

const log = logger.create('LiveTvPage');

class LiveTvPage extends Page {
    constructor(options = {}) {
        super(options);
        this.title = i18n.t('LiveTV');
        this._currentTab = 'suggestions';
        this._tabData = new Map(); // Cache data for tabs
        this._virtualRows = [];
        this._mediaGrids = [];
        this._isMounted = false;
        this._isAsyncPage = true;

        // Per-tab saved state (scroll, EPG position) for tab switches within the page
        this._tabState = new Map();

        // Pagination State
        this._startIndex = 0;
        this._totalCount = 0;
        this._limit = Number(storage.getItem('pref:libraryPageSize')) || 100;

        // Handlers
        this._onPageChange = this._handlePageChange.bind(this);
    }

    /**
     * Provide the correct scroll container for NavigationState capture/restore.
     */
    getScrollContainer() {
        return this.$('#livetv-scroll-container');
    }

    /**
     * Save page state for navigation history (back-navigation).
     * Captures current tab, per-tab scroll/EPG state, and pagination.
     */
    getNavigationState() {
        this._saveCurrentTabState();

        const state = {
            currentTab: this._currentTab,
            startIndex: this._startIndex,
            limit: this._limit,
            tabStates: {}
        };

        for (const [tabId, tabState] of this._tabState.entries()) {
            state.tabStates[tabId] = tabState;
        }

        return state;
    }

    /**
     * Restore page state from navigation history (back-navigation).
     * Sets the correct tab and per-tab state BEFORE content loads.
     */
    setNavigationState(savedState) {
        if (!savedState) return;

        this._currentTab = savedState.currentTab || 'suggestions';
        this._startIndex = savedState.startIndex || 0;
        this._limit = savedState.limit || Number(storage.getItem('pref:libraryPageSize')) || 100;

        this._tabState.clear();
        if (savedState.tabStates) {
            for (const [tabId, tabState] of Object.entries(savedState.tabStates)) {
                this._tabState.set(tabId, tabState);
            }
        }
    }

    render() {
        return `
            <div class="livetv-page page">
                <main class="page-content" id="livetv-scroll-container">
                    <div class="page-header">
                        <h1 data-i18n="LiveTV">${i18n.t('LiveTV')}</h1>
                        <div class="ltv-tab-header" id="livetv-tabs">
                            <div class="ltv-tab-indicator" id="ltv-tab-indicator"></div>
                            <button class="ltv-tab-btn active" data-tab="suggestions" tabindex="0">${i18n.t('Suggestions')}</button>
                            <button class="ltv-tab-btn" data-tab="guide" tabindex="0">${i18n.t('Guide')}</button>
                            <button class="ltv-tab-btn" data-tab="channels" tabindex="0">${i18n.t('Channels')}</button>
                            <button class="ltv-tab-btn" data-tab="recordings" tabindex="0">${i18n.t('Recordings')}</button>
                        </div>
                    </div>
                    <div class="tab-content" id="livetv-content">
                        <div class="page-loading"><div class="loading-spinner"></div></div>
                    </div>

                    <!-- Pagination Footer -->
                    <div class="pagination-footer hidden" id="livetv-pagination-container">
                        <div class="pagination-controls" id="livetv-pagination">
                            <button id="btn-prev" class="pagination-btn" tabindex="0">
                                <i class="fa-solid fa-chevron-left"></i>
                                <span>${i18n.t('Previous')}</span>
                            </button>
                            <span id="pagination-info" class="pagination-info"></span>
                            <button id="btn-next" class="pagination-btn" tabindex="0">
                                <span>${i18n.t('Next')}</span>
                                <i class="fa-solid fa-chevron-right"></i>
                            </button>
                        </div>
                    </div>
                </main>
            </div>
        `;
    }

    async onInit() {
        this._isMounted = true;

        // Sync tab button active states to match _currentTab before doing anything else.
        // The template defaults to 'suggestions', but setNavigationState may have
        // restored a different tab for back-navigation.
        this._syncTabState();

        this._setupTabHandlers();
        this._setupPaginationHandlers();
        this._attachDelegatedListeners();

        // Load the initial tab (set by setNavigationState for back-nav)
        await this._loadTab(this._currentTab);

        // Restore tab-specific state after content is fully rendered
        this._restoreCurrentTabState();

        // Initial selector position
        setTimeout(() => this._updateTabSelector(), 200);

        // Handle window resize for indicator alignment
        this._resizeHandler = () => this._updateTabSelector();
        window.addEventListener('resize', this._resizeHandler);

        this.markReady();

        /**
         * Handle back-navigation state restoration (if any).
         * For non-EPG tabs, NavigationState.restoreScrollFocus restores
         * native scroll position and focus by selector/index.
         * For the EPG guide tab, _restoreCurrentTabState handles it and
         * nullifies _pendingNavState to prevent overrides.
         */
        this.restoreScrollFocusWhenReady();
    }

    destroy() {
        this._isMounted = false;
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
        }
        this._virtualRows.forEach((row) => {
            if (row && row.destroy) row.destroy();
        });
        this._virtualRows = [];
        this._mediaGrids.forEach((g) => g.destroy());
        this._mediaGrids = [];
        super.destroy();
    }

    _setupTabHandlers() {
        const tabs = this.$('#livetv-tabs');
        tabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.ltv-tab-btn');
            if (btn) this._switchTab(btn.dataset.tab);
        });

        tabs.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const btn = e.target.closest('.ltv-tab-btn');
                if (btn) this._switchTab(btn.dataset.tab);
            }
        });

        // Focus registration for tabs — wire leave edges to sidebar and content
        // Use onMove to dynamically determine the target content section, since
        // the guide tab uses 'epg-grid' while other tabs use 'livetv-content-section'
        this.registerFocusSection('livetv-tabs', tabs, {
            orientation: 'horizontal',
            selector: '.ltv-tab-btn',
            leaveLeft: 'sidebar', // D-pad Left at first tab → goes to sidebar
            onMove: (direction) => {
                if (direction === 'down') {
                    // Pick the active content section dynamically
                    let targetSection = 'livetv-content-section';
                    if (this._currentTab === 'guide') {
                        targetSection = 'epg-grid';
                    } else if (this._currentTab === 'suggestions') {
                        targetSection = 'section-on-now';
                    }

                    if (focusManager.getConfig(targetSection)) {
                        focusManager.setActiveSection(targetSection);
                        return true; // Handled
                    }
                }
                return false; // Let default horizontal logic handle left/right
            }
        });

        // Sync indicator scale with active tab focus
        tabs.addEventListener('focusin', (e) => {
            const btn = e.target.closest('.ltv-tab-btn');
            if (btn && btn.classList.contains('active')) {
                this._updateTabSelector();
            }
        });

        tabs.addEventListener('focusout', () => {
            this._updateTabSelector();
        });

        // Sync indicator scale with mouse hover for the active tab
        tabs.addEventListener('mouseover', (e) => {
            const btn = e.target.closest('.ltv-tab-btn');
            if (btn && btn.classList.contains('active')) {
                this.$('#ltv-tab-indicator').classList.add('is-focused');
            } else {
                this.$('#ltv-tab-indicator').classList.remove('is-focused');
            }
        });

        tabs.addEventListener('mouseout', (e) => {
            // Only remove if we're actually leaving the button and it's not focused
            const btn = e.target.closest('.ltv-tab-btn');
            if (btn && document.activeElement !== btn) {
                this._updateTabSelector();
            }
        });
    }

    _setupPaginationHandlers() {
        this.$('#btn-prev')?.addEventListener('click', () => this._handlePageChange(-1));
        this.$('#btn-next')?.addEventListener('click', () => this._handlePageChange(1));
    }

    _attachDelegatedListeners() {
        const container = this.$('#livetv-content');
        if (!container) return;

        container.addEventListener('click', (e) => {
            const card = e.target.closest('.media-card');
            if (!card?.dataset?.itemId) return;

            log.info('Navigating to item details:', card.dataset.itemId);
            router.navigate(`/details/${card.dataset.itemId}`);
        });
    }

    /**
     * Sync tab button `active` classes to match `this._currentTab`.
     * Needed because the template hardcodes the first tab as active,
     * but back-navigation may restore a different tab.
     */
    _syncTabState() {
        const tabsEl = this.$('#livetv-tabs');
        if (!tabsEl) return;
        const btns = tabsEl.querySelectorAll('.ltv-tab-btn');
        btns.forEach((btn) => {
            const shouldBeActive = btn.dataset.tab === this._currentTab;
            btn.classList.toggle('active', shouldBeActive);
            btn.tabIndex = shouldBeActive ? 0 : -1;
        });
    }

    _switchTab(tabId) {
        if (this._currentTab === tabId) return;

        // Save state for the current tab before switching away
        this._saveCurrentTabState();

        // Update UI state
        this._syncTabState();

        this._currentTab = tabId;
        this._startIndex = 0; // Reset pagination for new tab
        this._loadTab(tabId);
        this._updateTabSelector();
    }

    /**
     * Moves the sliding background pill to the active tab's position.
     * Uses transform for 60FPS performance on Tizen.
     */
    _updateTabSelector() {
        const activeTab = this.$(`.ltv-tab-btn[data-tab="${this._currentTab}"]`);
        const indicator = this.$('#ltv-tab-indicator');

        if (activeTab && indicator) {
            // Add slight breathing room (+4px width) and center it (-2px offset)
            const left = activeTab.offsetLeft - 4;
            const width = activeTab.offsetWidth + 8;

            indicator.style.setProperty('--indicator-x', `${left}px`);
            indicator.style.width = `${width}px`;

            // Re-sync focus state
            if (document.activeElement === activeTab) {
                indicator.classList.add('is-focused');
            } else {
                indicator.classList.remove('is-focused');
            }
        }
    }

    async _loadTab(tabId) {
        const container = this.$('#livetv-content');
        container.innerHTML = '<div class="page-loading"><div class="loading-spinner"></div></div>';

        // Clean up previous tab's virtual rows, media grids, and focus sections
        this._virtualRows.forEach((row) => {
            if (row && row.destroy) row.destroy();
        });
        this._virtualRows = [];
        this._mediaGrids.forEach((g) => g.destroy());
        this._mediaGrids = [];

        for (const name of this._focusSections) {
            if (name !== 'livetv-tabs' && name !== 'livetv-pagination') {
                focusManager.unregister(name);
            }
        }
        this._focusSections = this._focusSections.filter(
            (name) => name === 'livetv-tabs' || name === 'livetv-pagination'
        );

        try {
            switch (tabId) {
                case 'suggestions':
                    await this._renderSuggestions();
                    break;
                case 'guide':
                    await this._renderGuide();
                    break;
                case 'channels':
                    await this._renderChannels();
                    break;
                case 'recordings':
                    await this._renderRecordings();
                    break;
            }

            // Sync tab button active states (back-nav may have restored a different tab)
            this._syncTabState();

            // Restore tab-specific state after content is rendered
            this._restoreCurrentTabState();
        } catch (err) {
            log.error(`Failed to load tab ${tabId}:`, err);
            container.innerHTML = `<div class="page-error">${i18n.t('ErrorLoadingData')}</div>`;
        }
    }

    // =========================================================================
    // Tab Renderers
    // =========================================================================

    async _renderSuggestions() {
        const container = this.$('#livetv-content');
        container.innerHTML = '<div class="home-rows" id="suggestions-rows"></div>';
        const rowsContainer = this.$('#suggestions-rows');

        // Fetch Recommended Programs
        const programs = await api.getLiveTvRecommendedPrograms({
            userId: api.userId,
            limit: 24,
            enableImageTypes: 'Primary,Thumb,Backdrop',
            fields: 'CanSelfDelete,SortName'
        });

        if (!this._isMounted) return;

        if (programs.Items && programs.Items.length > 0) {
            this._createRow(rowsContainer, i18n.t('OnNow'), programs.Items, {
                id: 'on-now',
                isLandscape: true,
                cardType: 'thumb',
                leaveUp: 'livetv-tabs',
                leaveLeft: 'sidebar'
            });
        } else {
            rowsContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                            <line x1="8" y1="21" x2="16" y2="21"></line>
                            <line x1="12" y1="17" x2="12" y2="21"></line>
                        </svg>
                    </div>
                    <div class="empty-title">${i18n.t('NoItemsFound')}</div>
                    <div class="empty-description">Check back later for live program recommendations.</div>
                </div>
            `;
        }
    }

    async _renderChannels() {
        const container = this.$('#livetv-content');
        const channels = await api.getLiveTvChannels({
            userId: api.userId,
            startIndex: this._startIndex,
            limit: this._limit,
            enableImageTypes: 'Primary,Thumb,Backdrop'
        });

        if (!this._isMounted) return;

        this._totalCount = channels.TotalRecordCount || 0;
        this._updatePaginationUI();

        if (!channels.Items || channels.Items.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                            <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                            <rect x="14" y="14" width="7" height="7" rx="1"></rect>
                            <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                        </svg>
                    </div>
                    <div class="empty-title">${i18n.t('NoItemsFound')}</div>
                    <div class="empty-description">No live TV channels found on your server.</div>
                </div>
            `;
            return;
        }

        const grid = new MediaGrid({
            id: 'livetv-channels-grid',
            title: '',
            items: channels.Items || [],
            type: 'square',
            limit: this._limit,
            allowSeeMore: false
        });

        container.innerHTML = grid.render();
        grid.onMounted();
        this._mediaGrids.push(grid);

        const gridItemsEl = this.$('#livetv-channels-grid-items');
        if (gridItemsEl) {
            this.registerFocusSection('livetv-content-section', gridItemsEl, {
                orientation: 'both',
                selector: '.media-card',
                leaveUp: 'livetv-tabs', // D-pad Up from top row → back to tabs
                leaveDown: 'livetv-pagination',
                leaveLeft: 'sidebar' // D-pad Left → sidebar
            });
        }
    }

    async _renderRecordings() {
        const container = this.$('#livetv-content');
        const recordings = await api.getLiveTvRecordings({
            userId: api.userId,
            startIndex: this._startIndex,
            limit: this._limit,
            enableImageTypes: 'Primary,Thumb,Backdrop'
        });

        if (!this._isMounted) return;

        this._totalCount = recordings.TotalRecordCount || 0;
        this._updatePaginationUI();

        if (!recordings.Items || recordings.Items.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <circle cx="12" cy="12" r="3" fill="currentColor" class="record-dot"></circle>
                        </svg>
                    </div>
                    <div class="empty-title">${i18n.t('NoItemsFound')}</div>
                    <div class="empty-description">You haven't recorded any programs yet.</div>
                </div>
            `;
            return;
        }

        const grid = new MediaGrid({
            id: 'livetv-recordings-grid',
            title: '',
            items: recordings.Items || [],
            type: 'thumb',
            isLandscape: true,
            limit: this._limit,
            allowSeeMore: false
        });

        container.innerHTML = grid.render();
        grid.onMounted();
        this._mediaGrids.push(grid);

        const gridItemsEl = this.$('#livetv-recordings-grid-items');
        if (gridItemsEl) {
            this.registerFocusSection('livetv-content-section', gridItemsEl, {
                orientation: 'both',
                selector: '.media-card',
                leaveUp: 'livetv-tabs', // D-pad Up from top row → back to tabs
                leaveDown: 'livetv-pagination',
                leaveLeft: 'sidebar' // D-pad Left → sidebar
            });
        }
    }

    async _renderGuide() {
        const container = this.$('#livetv-content');
        container.innerHTML = '<div id="epg-mount"></div>';

        const epg = new EpgGrid(container.querySelector('#epg-mount'), {
            // Wire up Out-of-bounds exits for D-pad navigation
            leaveUp: 'livetv-tabs',
            leaveLeft: 'sidebar'
        });
        await epg.init();
        // _focusNow() inside epg.init() will call focusManager.focusElement on a program,
        // which auto-syncs the active section to 'epg-grid' via the focusin listener.

        this._virtualRows.push(epg);

        // Hide pagination for guide
        const pagContainer = this.$('#livetv-pagination-container');
        if (pagContainer) pagContainer.classList.add('hidden');
    }

    _updatePaginationUI() {
        const container = this.$('#livetv-pagination-container');
        if (!container) return;

        // Suggestions tab doesn't use standard pagination footer
        if (this._currentTab === 'suggestions' || this._currentTab === 'guide') {
            container.classList.add('hidden');
            focusManager.unregister('livetv-pagination');
            return;
        }

        const moreThanOnePage = this._totalCount > this._limit;
        if (!moreThanOnePage) {
            container.classList.add('hidden');
            focusManager.unregister('livetv-pagination');
            return;
        }

        container.classList.remove('hidden');

        const btnPrev = this.$('#btn-prev');
        const btnNext = this.$('#btn-next');
        const info = this.$('#pagination-info');

        const hasPrev = this._startIndex > 0;
        const hasNext = this._startIndex + this._limit < this._totalCount;

        if (btnPrev) {
            btnPrev.disabled = !hasPrev;
            btnPrev.classList.toggle('disabled', !hasPrev);
        }
        if (btnNext) {
            btnNext.disabled = !hasNext;
            btnNext.classList.toggle('disabled', !hasNext);
        }

        if (info) {
            const start = this._startIndex + 1;
            const end = Math.min(this._startIndex + this._limit, this._totalCount);
            info.textContent = i18n.t('ListPaging', [start, end, this._totalCount]);
        }

        // Register for focus
        focusManager.register('livetv-pagination', this.$('#livetv-pagination'), {
            orientation: 'horizontal',
            leaveUp: 'livetv-content-section',
            leaveLeft: 'sidebar',
            selector: 'button:not(.disabled)',
            enterTo: 'active-element'
        });
    }

    async _handlePageChange(direction) {
        const nextIndex = this._startIndex + direction * this._limit;

        if (nextIndex < 0 || nextIndex >= this._totalCount) return;

        // Save current focus/scroll before pagination
        this._saveCurrentTabState();

        this._startIndex = nextIndex;
        // Clear stale tab state BEFORE _loadTab so _restoreCurrentTabState
        // (called inside _loadTab) doesn't restore the old page's position
        this._tabState.delete(this._currentTab);
        await this._loadTab(this._currentTab);

        // Scroll back to top
        const scrollContainer = this.$('#livetv-scroll-container');
        if (scrollContainer) scrollContainer.scrollTop = 0;

        // Focus the first item in the new page
        const firstItem = this.$('#livetv-content .media-card');
        if (firstItem) {
            focusManager.focusElement(firstItem);
        } else {
            this.setActiveSection('livetv-tabs');
        }
    }

    // =========================================================================
    // Tab State Save / Restore
    // =========================================================================

    /**
     * Save the current tab's scroll position and EPG virtual state.
     * Called before switching tabs within the page, and from getNavigationState().
     */
    _saveCurrentTabState() {
        const container = this.$('#livetv-scroll-container');
        const state = {
            scrollTop: container ? container.scrollTop : 0
        };

        // Save focus position
        const focused = focusManager.getFocused();
        if (focused) {
            const section = focusManager.getSectionForElement(focused);
            if (section) {
                state.focusSection = section;
                const focusables = focusManager._getFocusables(section);
                state.focusIndex = focusables.indexOf(focused);
            }
        }

        // Save EPG virtual scroll state (guide tab only)
        if (this._currentTab === 'guide') {
            const epg = this._virtualRows.find((r) => r instanceof EpgGrid);
            if (epg && !epg._isDestroyed) {
                state.epgScrollX = epg.scrollX;
                state.epgScrollY = epg.scrollY;
                state.epgFocusedChannelId = epg._focusedEl?.dataset?.channelId || null;
                state.epgFocusedProgramId = epg._focusedEl?.dataset?.programId || null;
            }
        }

        this._tabState.set(this._currentTab, state);
    }

    /**
     * Restore the current tab's scroll position, EPG state, and focus.
     * Called after tab content is rendered in _loadTab().
     * For the EPG guide tab, this handles virtual scroll restoration that
     * the standard NavigationState mechanism cannot (it only knows native scrollTop).
     */
    _restoreCurrentTabState() {
        const state = this._tabState.get(this._currentTab);

        // EPG Guide Tab — custom virtual scroll + focus restoration
        if (this._currentTab === 'guide') {
            const epg = this._virtualRows.find((r) => r instanceof EpgGrid);
            if (!epg || epg._isDestroyed) return;

            if (state) {
                if (state.epgScrollX !== undefined) epg.scrollX = state.epgScrollX;
                if (state.epgScrollY !== undefined) epg.scrollY = state.epgScrollY;
                epg._renderVirtualGrid();

                // Try to restore focus to the previously focused program
                if (state.epgFocusedProgramId) {
                    const data = epg.domNodes.get(state.epgFocusedChannelId);
                    if (data) {
                        const el = data.rowEl.querySelector(`[data-program-id="${state.epgFocusedProgramId}"]`);
                        if (el) {
                            epg._focusedEl = el;
                            focusManager.focusElement(el);
                            this._pendingNavState = null;
                            return;
                        }
                    }
                }

                // Fall back to the previously focused channel row
                if (state.epgFocusedChannelId) {
                    const data = epg.domNodes.get(state.epgFocusedChannelId);
                    if (data && data.channelEl) {
                        epg._focusedEl = data.channelEl;
                        focusManager.focusElement(data.channelEl);
                        this._pendingNavState = null;
                        return;
                    }
                }
            }

            // No saved state or couldn't restore — focus current program
            epg._focusNow();
            // Prevent standard NavigationState from overriding EPG focus
            this._pendingNavState = null;
            return;
        }

        // Non-EPG tabs
        if (!state) {
            // Forward navigation (no saved state) — default focus to tabs
            if (!focusManager.getFocused()) {
                this.setActiveSection('livetv-tabs');
            }
            return;
        }

        // Restore native scroll position for non-EPG tabs
        const container = this.$('#livetv-scroll-container');
        if (container && state.scrollTop > 0) {
            container.scrollTop = state.scrollTop;
        }

        // Restore focus for tab switches within the page (no _pendingNavState)
        if (!this._pendingNavState && state.focusSection) {
            const config = focusManager.getConfig(state.focusSection);
            if (config) {
                this.setActiveSection(state.focusSection);
                if (state.focusIndex >= 0) {
                    const focusables = focusManager._getFocusables(state.focusSection);
                    if (state.focusIndex < focusables.length) {
                        focusManager.focusElement(focusables[state.focusIndex]);
                        return;
                    }
                }
            }
        }

        // Default: leave focus to be handled by NavigationState.restoreScrollFocus
        // or set to tabs if no _pendingNavState and nothing focused yet
        if (!this._pendingNavState && !focusManager.getFocused()) {
            this.setActiveSection('livetv-tabs');
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    _createRow(container, title, items, options = {}) {
        const rowId = options.id || `row-${Math.random().toString(36).substr(2, 9)}`;
        const sectionId = `section-${rowId}`;

        const rowHtml = `
            <div class="media-row" id="${rowId}">
                <h2 class="row-title">${title}</h2>
                <div class="row-items">
                    <div class="row-items-track" id="${sectionId}"></div>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', rowHtml);

        const track = document.getElementById(sectionId);
        const virtualRow = new VirtualCardRow(track, items, {
            isLandscape: options.isLandscape || false,
            cardType: options.cardType || 'poster',
            focusSectionId: sectionId,
            renderCard: (item) =>
                CardRenderer.createCardHtml(item, {
                    isLandscape: options.isLandscape,
                    type: options.cardType,
                    contextType: 'livetv'
                })
        });

        this._virtualRows.push(virtualRow);

        this.registerFocusSection(sectionId, track, {
            orientation: 'horizontal',
            selector: '.media-card',
            indices: true,
            leaveUp: options.leaveUp,
            leaveDown: options.leaveDown,
            leaveLeft: options.leaveLeft,
            leaveRight: options.leaveRight,
            // Handle horizontal navigation within the virtual row
            onMove: (direction, currentElement) => {
                if (!currentElement || currentElement.dataset.virtualIndex === undefined) {
                    return false; // Let spatial nav take over
                }
                const idx = parseInt(currentElement.dataset.virtualIndex, 10);
                const nextNode = virtualRow.handleMove(direction, idx);
                if (nextNode) {
                    focusManager.focusElement(nextNode);
                    return true;
                }
                return false;
            },
            // Restore last-focused position in this row when entering from another row
            onEnter: (fromElement, options) => {
                if (fromElement && options && (options.direction === 'up' || options.direction === 'down')) {
                    const existingNode = virtualRow.domNodes.get(virtualRow.currentIndex);
                    if (existingNode && existingNode.isConnected) {
                        return existingNode;
                    }
                    virtualRow._updateWindow(virtualRow.currentIndex);
                    return virtualRow.domNodes.get(virtualRow.currentIndex);
                }
                return null;
            },
            // Restore specific virtual index
            onRestoreIndex: (index) => virtualRow.focusByIndex(index)
        });

        return virtualRow;
    }
}

export default LiveTvPage;
