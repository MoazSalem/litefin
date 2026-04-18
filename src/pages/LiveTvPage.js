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

const log = logger.create('LiveTvPage');

class LiveTvPage extends Page {
    constructor(options = {}) {
        super(options);
        this.title = i18n.t('LiveTV');
        this._currentTab = 'suggestions';
        this._tabData = new Map(); // Cache data for tabs
        this._virtualRows = [];
        this._isMounted = false;

        // Pagination State
        this._startIndex = 0;
        this._totalCount = 0;
        this._limit = Number(storage.getItem('pref:libraryPageSize')) || 100;

        // Handlers
        this._onPageChange = this._handlePageChange.bind(this);
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

    onInit() {
        this._isMounted = true;
        this._setupTabHandlers();
        this._setupPaginationHandlers();
        
        // Load the initial tab (usually Suggestions)
        this._loadTab(this._currentTab);

        /**
         * =====================================================================
         * INITIAL FOCUS
         * =====================================================================
         * When entering the page via forward navigation (e.g., from Home),
         * we explicitly set focus to the tab switcher so the user has immediate
         * feedback and control.
         */
        this.setActiveSection('livetv-tabs');

        // Initial selector position
        setTimeout(() => this._updateTabSelector(), 200);

        // Handle window resize for indicator alignment
        this._resizeHandler = () => this._updateTabSelector();
        window.addEventListener('resize', this._resizeHandler);

        this.markReady();

        /**
         * Handle back-navigation state restoration (if any).
         * If the user is returning to this page, this will restore their
         * previous scroll position and focused element.
         */
        this.restoreScrollFocusWhenReady();
    }

    onDestroy() {
        this._isMounted = false;
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
        }
        this._virtualRows.forEach((row) => {
            if (row && row.destroy) row.destroy();
        });
        this._virtualRows = [];
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
                    const targetSection = this._currentTab === 'guide'
                        ? 'epg-grid'
                        : 'livetv-content-section';
                    focusManager.setActiveSection(targetSection);
                    return true; // Handled
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

    _switchTab(tabId) {
        if (this._currentTab === tabId) return;

        // Update UI state
        const oldTab = this.$(`.ltv-tab-btn[data-tab="${this._currentTab}"]`);
        const newTab = this.$(`.ltv-tab-btn[data-tab="${tabId}"]`);

        if (oldTab) oldTab.classList.remove('active');
        if (newTab) newTab.classList.add('active');

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

        // Reset virtual rows
        this._virtualRows = [];
        focusManager.unregister('livetv-content-section');

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
            fields: 'PrimaryImageAspectRatio,CanSelfDelete,SortName'
        });

        if (!this._isMounted) return;

        if (programs.Items && programs.Items.length > 0) {
            this._createRow(rowsContainer, i18n.t('OnNow'), programs.Items, {
                id: 'on-now',
                isLandscape: true,
                cardType: 'thumb'
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

        const gridItemsEl = this.$('#livetv-channels-grid-items');
        if (gridItemsEl) {
            this.registerFocusSection('livetv-content-section', gridItemsEl, {
                orientation: 'both',
                selector: '.media-card',
                leaveUp: 'livetv-tabs',   // D-pad Up from top row → back to tabs
                leaveDown: 'livetv-pagination',
                leaveLeft: 'sidebar'      // D-pad Left → sidebar
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

        const gridItemsEl = this.$('#livetv-recordings-grid-items');
        if (gridItemsEl) {
            this.registerFocusSection('livetv-content-section', gridItemsEl, {
                orientation: 'both',
                selector: '.media-card',
                leaveUp: 'livetv-tabs', // D-pad Up from top row → back to tabs
                leaveDown: 'livetv-pagination',
                leaveLeft: 'sidebar'    // D-pad Left → sidebar
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

        this._startIndex = nextIndex;
        await this._loadTab(this._currentTab);

        // Scroll back to top
        const scrollContainer = this.$('#livetv-scroll-container');
        if (scrollContainer) scrollContainer.scrollTop = 0;

        // Try to focus the first item in the new page
        const firstItem = this.$('#livetv-content .media-card');
        if (firstItem) {
            focusManager.focusElement(firstItem);
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
                <div class="row-items-container">
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
            indices: true
        });

        // Bind horizontal movement
        focusManager.setHandler(sectionId, 'left', () =>
            virtualRow.handleMove('left', focusManager.getSelectedIndex(sectionId))
        );
        focusManager.setHandler(sectionId, 'right', () =>
            virtualRow.handleMove('right', focusManager.getSelectedIndex(sectionId))
        );

        return virtualRow;
    }
}

export default LiveTvPage;
